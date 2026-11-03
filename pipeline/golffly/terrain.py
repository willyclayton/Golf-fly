"""Height grids: oriented sampling grids, smoothing and a compact encoding.

Grids are rotated to the hole: the u axis points down the line of play (tee to
green for a hole, approach direction for a green), and v points 90 degrees to
the left of it. ``values[row, col]`` is the height at the cell centre
``u = (col + 0.5) * cell``, ``v = (row + 0.5) * cell``, measured from the grid
origin. In local metres, a (u, v) offset maps to

    x = origin_x + u * cos(rotation) - v * sin(rotation)
    y = origin_y + u * sin(rotation) + v * cos(rotation)

Encoding (``u16-delta-shuffle-gzip``): heights are quantised to
``base_m + q * step_m`` with q a uint16 (65535 = no data), each row is
delta-coded left to right (mod 65536), the low bytes of all cells are written
before the high bytes, and the result is gzipped. Decoding reverses those
steps; see ``decode_heights``.
"""

from __future__ import annotations

import gzip
import math
from dataclasses import dataclass

import numpy as np
from shapely import affinity
from shapely.geometry.base import BaseGeometry

from .elevation import Raster
from .geo import LocalFrame, rotate

NODATA_Q = 65535
MAX_Q = 65000
ENCODING = "u16-delta-shuffle-gzip"


@dataclass
class GridSpec:
    origin: tuple[float, float]  # local x, y of the (u=0, v=0) corner
    rotation: float  # radians, counter-clockwise from east, of the u axis
    cell: float  # metres
    cols: int
    rows: int

    def centers(self) -> tuple[np.ndarray, np.ndarray]:
        """Local x, y of every cell centre, each shaped (rows, cols)."""
        u = (np.arange(self.cols) + 0.5) * self.cell
        v = (np.arange(self.rows) + 0.5) * self.cell
        uu, vv = np.meshgrid(u, v)
        x, y = rotate(uu, vv, self.rotation)
        return x + self.origin[0], y + self.origin[1]

    def to_json(self) -> dict:
        return {
            "origin": [round(self.origin[0], 3), round(self.origin[1], 3)],
            "rotation_deg": round(math.degrees(self.rotation), 4),
            "cell_m": self.cell,
            "cols": self.cols,
            "rows": self.rows,
        }


def oriented_grid(geom: BaseGeometry, rotation: float, cell: float, pad: float) -> GridSpec:
    """Smallest grid with its u axis along ``rotation`` that covers geom plus pad."""
    rot = affinity.rotate(geom, -rotation, origin=(0.0, 0.0), use_radians=True)
    umin, vmin, umax, vmax = rot.bounds
    umin, vmin, umax, vmax = umin - pad, vmin - pad, umax + pad, vmax + pad
    cols = max(2, math.ceil((umax - umin) / cell))
    rows = max(2, math.ceil((vmax - vmin) / cell))
    ox, oy = rotate(umin, vmin, rotation)
    return GridSpec((float(ox), float(oy)), rotation, cell, cols, rows)


def grid_utm_bounds(spec: GridSpec, frame: LocalFrame, margin: float) -> tuple[float, float, float, float]:
    x, y = spec.centers()
    e, n = frame.to_utm(
        np.array([x[0, 0], x[0, -1], x[-1, 0], x[-1, -1]]), np.array([y[0, 0], y[0, -1], y[-1, 0], y[-1, -1]])
    )
    return float(e.min() - margin), float(n.min() - margin), float(e.max() + margin), float(n.max() + margin)


def sample_grid(spec: GridSpec, raster: Raster, frame: LocalFrame) -> np.ndarray:
    x, y = spec.centers()
    e, n = frame.to_utm(x.ravel(), y.ravel())
    return raster.sample(e, n).reshape(spec.rows, spec.cols).astype(np.float32)


def _conv1d(a: np.ndarray, w: np.ndarray, axis: int) -> np.ndarray:
    r = len(w) // 2
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r, r)
    p = np.pad(a, pad)
    n = a.shape[axis]
    out = np.zeros_like(a)
    for i, wi in enumerate(w):
        out += wi * (p[i : i + n, :] if axis == 0 else p[:, i : i + n])
    return out


def gaussian_smooth(values: np.ndarray, sigma_cells: float) -> np.ndarray:
    """Gaussian blur that ignores no-data cells (normalised convolution); no-data stays no-data."""
    if sigma_cells <= 0:
        return values.copy()
    r = max(1, math.ceil(3 * sigma_cells))
    x = np.arange(-r, r + 1, dtype=np.float64)
    w = np.exp(-(x**2) / (2 * sigma_cells**2))
    w /= w.sum()
    finite = np.isfinite(values)
    filled = np.where(finite, values, 0.0).astype(np.float64)
    num = _conv1d(_conv1d(filled, w, 0), w, 1)
    den = _conv1d(_conv1d(finite.astype(np.float64), w, 0), w, 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[~finite] = np.nan
    return out.astype(np.float32)


def fill_gaps(values: np.ndarray, max_passes: int = 8) -> np.ndarray:
    """Fill small no-data holes (lidar dropouts over water, bridges) from their neighbours."""
    out = values.astype(np.float64).copy()
    for _ in range(max_passes):
        missing = ~np.isfinite(out)
        if not missing.any() or missing.all():
            break
        p = np.pad(np.where(missing, 0.0, out), 1)
        w = np.pad((~missing).astype(np.float64), 1)
        num = p[:-2, 1:-1] + p[2:, 1:-1] + p[1:-1, :-2] + p[1:-1, 2:]
        den = w[:-2, 1:-1] + w[2:, 1:-1] + w[1:-1, :-2] + w[1:-1, 2:]
        can = missing & (den > 0)
        out[can] = num[can] / den[can]
    return out.astype(np.float32)


def encode_heights(values: np.ndarray, step_m: float) -> tuple[bytes, dict]:
    finite = np.isfinite(values)
    if not finite.any():
        raise ValueError("grid has no valid heights")
    lo = float(np.nanmin(values))
    hi = float(np.nanmax(values))
    base = math.floor(lo / step_m) * step_m
    step = step_m
    while (hi - base) / step > MAX_Q:
        step *= 2
    q = np.full(values.shape, NODATA_Q, dtype=np.int64)
    q[finite] = np.round((values[finite] - base) / step).astype(np.int64)
    d = q.copy()
    d[:, 1:] = (q[:, 1:] - q[:, :-1]) & 0xFFFF
    d = d.astype("<u2")
    b = d.view(np.uint8).reshape(-1, 2)
    payload = gzip.compress(np.concatenate([b[:, 0], b[:, 1]]).tobytes(), compresslevel=9, mtime=0)
    header = {
        "encoding": ENCODING,
        "base_m": round(base, 4),
        "step_m": step,
        "nodata": NODATA_Q,
        "min_m": round(lo, 3),
        "max_m": round(hi, 3),
        "valid_fraction": round(float(finite.mean()), 4),
    }
    return payload, header


def decode_heights(payload: bytes, header: dict, rows: int, cols: int) -> np.ndarray:
    raw = np.frombuffer(gzip.decompress(payload), dtype=np.uint8)
    n = rows * cols
    d = (raw[:n].astype(np.uint32) | (raw[n:].astype(np.uint32) << 8)).reshape(rows, cols)
    q = np.cumsum(d, axis=1, dtype=np.uint64) & 0xFFFF
    out = header["base_m"] + q.astype(np.float64) * header["step_m"]
    out[q == header["nodata"]] = np.nan
    return out
