"""Bare-earth elevation (DTM) from ArcGIS image services.

Sources are tried in priority order (ISGS county lidar first, USGS 3DEP last).
A source is used for a course only if a small preview image of the course box
has valid data over ``MIN_COVERAGE`` of its pixels, so county edges sort
themselves out without county boundary files. Rasters are requested in the
course's UTM zone and sampled onto the pipeline's own grids afterwards.
"""

from __future__ import annotations

import json
import logging
import math
import re
import warnings
from dataclasses import dataclass, field

import numpy as np
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile

from .geo import M_PER_FT
from .http import Http, HttpError, RetryableResponse

log = logging.getLogger(__name__)

MIN_COVERAGE = 0.99
PREVIEW_PX = 96
DEFAULT_MAX_PX = 2048
# Ground in the Chicago region sits 170-330 m (560-1080 ft) above sea level.
# Anything outside this window is fill or no-data, whatever the units.
PLAUSIBLE_RAW = (50.0, 5000.0)
FEET_THRESHOLD = 450.0  # a median above this cannot be metres here


class ElevationError(RuntimeError):
    pass


@dataclass(frozen=True)
class ElevationSource:
    key: str
    name: str
    url: str  # ImageServer root
    quality: str  # lidar quality level
    confidence: str  # green confidence badge
    year: int | None = None  # collection year, when known up front
    credit: str = ""
    units: str = "auto"  # "auto", "m" or "ft"


SOURCES: tuple[ElevationSource, ...] = (
    ElevationSource(
        "isgs-cook-2022",
        "ISGS Cook County 2022 lidar DTM",
        "https://data.isgs.illinois.edu/arcgis/rest/services/Elevation/IL_Cook_DTM_2022/ImageServer",
        "QL1",
        "High",
        2022,
        "Illinois State Geological Survey",
    ),
    ElevationSource(
        "isgs-dupage-2022",
        "ISGS DuPage County 2022 lidar DTM",
        "https://data.isgs.illinois.edu/arcgis/rest/services/Elevation/IL_DuPage_DTM_2022/ImageServer",
        "QL2+",
        "Medium",
        2022,
        "Illinois State Geological Survey",
    ),
    ElevationSource(
        "usgs-3dep",
        "USGS 3DEP lidar DEM (best available)",
        "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer",
        "QL2",
        "Low",
        None,
        "U.S. Geological Survey, 3D Elevation Program",
    ),
)


@dataclass
class Raster:
    """North-up raster in a UTM zone. data[row, col], row 0 at the north edge."""

    data: np.ndarray  # float32 metres, NaN where there is no data
    x0: float  # west edge
    y0: float  # north edge
    px: float  # pixel width (m)
    py: float  # pixel height (m), positive
    epsg: int

    @property
    def coverage(self) -> float:
        return float(np.isfinite(self.data).mean()) if self.data.size else 0.0

    def sample(self, e, n) -> np.ndarray:
        """Bilinear interpolation at UTM points; NaN outside the raster or next to no-data."""
        e = np.asarray(e, dtype=float)
        n = np.asarray(n, dtype=float)
        c = (e - self.x0) / self.px - 0.5
        r = (self.y0 - n) / self.py - 0.5
        c0 = np.floor(c).astype(np.int64)
        r0 = np.floor(r).astype(np.int64)
        h, w = self.data.shape
        ok = (c0 >= 0) & (r0 >= 0) & (c0 + 1 < w) & (r0 + 1 < h)
        out = np.full(e.shape, np.nan)
        fc, fr = c[ok] - c0[ok], r[ok] - r0[ok]
        ci, ri, d = c0[ok], r0[ok], self.data
        out[ok] = (
            d[ri, ci] * (1 - fc) * (1 - fr)
            + d[ri, ci + 1] * fc * (1 - fr)
            + d[ri + 1, ci] * (1 - fc) * fr
            + d[ri + 1, ci + 1] * fc * fr
        )
        return out


@dataclass
class ResolvedSource:
    source: ElevationSource
    scale: float  # multiply raw values by this to get metres
    coverage: float
    max_px: int = DEFAULT_MAX_PX
    metadata: dict = field(default_factory=dict)

    @property
    def units(self) -> str:
        return "ft" if self.scale != 1.0 else "m"


def _tiff_validator(body: bytes, ctype: str) -> None:
    if body[:4] in (b"II*\x00", b"MM\x00*", b"II+\x00", b"MM\x00+"):
        return
    text = body[:600].decode("utf-8", "replace")
    if text.lstrip().startswith("{"):
        try:
            err = json.loads(body).get("error") or {}
        except ValueError:
            err = {}
        code = int(err.get("code") or 0)
        if code >= 500 or code == 0:
            raise RetryableResponse(f"image server error: {text[:300]}")
        raise ElevationError(f"image server refused the request: {text[:300]}")
    raise RetryableResponse(f"not a TIFF: {text[:200]!r}")


def read_tiff(body: bytes, bbox: tuple[float, float, float, float], size: tuple[int, int], epsg: int) -> Raster:
    """Parse a single-band TIFF into a Raster with implausible values set to NaN."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", NotGeoreferencedWarning)
        with MemoryFile(body) as mf, mf.open() as ds:
            data = ds.read(1).astype(np.float32)
            nodata = ds.nodata
            t = ds.transform
            georeferenced = not t.is_identity and t.b == 0 and t.d == 0 and t.e < 0
    bad = ~np.isfinite(data) | (data < PLAUSIBLE_RAW[0]) | (data > PLAUSIBLE_RAW[1])
    if nodata is not None and np.isfinite(nodata):
        bad |= data == np.float32(nodata)
    data[bad] = np.nan
    if georeferenced:
        return Raster(data, t.c, t.f, t.a, -t.e, epsg)
    xmin, ymin, xmax, ymax = bbox
    w, h = size
    return Raster(data, xmin, ymax, (xmax - xmin) / w, (ymax - ymin) / h, epsg)


def export_image(
    http: Http, source: ElevationSource, bbox: tuple[float, float, float, float], size: tuple[int, int], epsg: int
) -> Raster:
    xmin, ymin, xmax, ymax = bbox
    w, h = size
    params = {
        "bbox": f"{xmin:.3f},{ymin:.3f},{xmax:.3f},{ymax:.3f}",
        "bboxSR": str(epsg),
        "imageSR": str(epsg),
        "size": f"{w},{h}",
        "format": "tiff",
        "pixelType": "F32",
        "noDataInterpretation": "esriNoDataMatchAny",
        "interpolation": "RSP_BilinearInterpolation",
        "renderingRule": json.dumps({"rasterFunction": "None"}),
        "f": "image",
    }
    body, _ = http.fetch("GET", source.url + "/exportImage", params=params, validate=_tiff_validator)
    return read_tiff(body, bbox, size, epsg)


def _check_not_rendered(raster: Raster, source: ElevationSource) -> None:
    vals = raster.data[np.isfinite(raster.data)]
    if vals.size > 100 and float(np.mean(vals == np.round(vals))) > 0.9:
        raise ElevationError(f"{source.key} returned whole numbers only; that looks like a rendered image, not elevations")


def _unit_scale(source: ElevationSource, raster: Raster) -> float:
    if source.units == "m":
        return 1.0
    if source.units == "ft":
        return M_PER_FT
    vals = raster.data[np.isfinite(raster.data)]
    return M_PER_FT if vals.size and float(np.median(vals)) > FEET_THRESHOLD else 1.0


def service_max_px(http: Http, source: ElevationSource) -> int:
    try:
        info = http.get_json(source.url, {"f": "json"})
    except (HttpError, ValueError) as exc:
        log.warning("could not read %s service info: %s", source.key, exc)
        return DEFAULT_MAX_PX
    limit = min(int(info.get("maxImageWidth") or DEFAULT_MAX_PX), int(info.get("maxImageHeight") or DEFAULT_MAX_PX))
    return max(256, min(limit, DEFAULT_MAX_PX))


def choose_source(
    http: Http,
    bbox: tuple[float, float, float, float],
    epsg: int,
    sources: tuple[ElevationSource, ...] = SOURCES,
) -> ResolvedSource:
    """First source with valid data over the whole box (preview check)."""
    notes = []
    for source in sources:
        try:
            preview = export_image(http, source, bbox, (PREVIEW_PX, PREVIEW_PX), epsg)
        except (HttpError, ElevationError) as exc:
            notes.append(f"{source.key}: {exc}")
            log.warning("elevation source %s unavailable: %s", source.key, exc)
            continue
        cov = preview.coverage
        notes.append(f"{source.key}: {cov:.1%} coverage")
        log.info("elevation source %s covers %.1f%% of the course box", source.key, cov * 100)
        if cov >= MIN_COVERAGE:
            _check_not_rendered(preview, source)
            scale = _unit_scale(source, preview)
            resolved = ResolvedSource(source, scale, cov, service_max_px(http, source))
            resolved.metadata["selection"] = notes
            return resolved
    raise ElevationError("no elevation source covers this course: " + "; ".join(notes))


def fetch_raster(
    http: Http, src: ResolvedSource, bbox: tuple[float, float, float, float], px: float, epsg: int
) -> Raster:
    """Raster of the box at the given pixel size (metres), tiled to the server's size limit."""
    xmin, ymin, xmax, ymax = bbox
    cols = max(2, math.ceil((xmax - xmin) / px))
    rows = max(2, math.ceil((ymax - ymin) / px))
    out = np.full((rows, cols), np.nan, dtype=np.float32)
    tile = src.max_px
    for r0 in range(0, rows, tile):
        for c0 in range(0, cols, tile):
            h, w = min(tile, rows - r0), min(tile, cols - c0)
            tb = (xmin + c0 * px, ymax - (r0 + h) * px, xmin + (c0 + w) * px, ymax - r0 * px)
            sub = export_image(http, src.source, tb, (w, h), epsg)
            aligned = (
                sub.data.shape == (h, w)
                and abs(sub.x0 - tb[0]) < 0.01 * px
                and abs(sub.y0 - tb[3]) < 0.01 * px
                and abs(sub.px - px) < 1e-6 * px
            )
            if aligned:
                out[r0 : r0 + h, c0 : c0 + w] = sub.data
            else:
                cc, rr = np.meshgrid(np.arange(w), np.arange(h))
                e = tb[0] + (cc + 0.5) * px
                n = tb[3] - (rr + 0.5) * px
                out[r0 : r0 + h, c0 : c0 + w] = sub.sample(e, n)
    out *= np.float32(src.scale)
    return Raster(out, xmin, ymax, px, px, epsg)


_YEAR_RE = re.compile(r"(?<!\d)(19[89]\d|20[0-4]\d)(?!\d)")


def _year_of(value) -> int | None:
    if isinstance(value, (int, float)) and value > 1e11:  # epoch milliseconds
        y = 1970 + int(value // (365.2425 * 86400 * 1000))
        return y if 1980 <= y <= 2049 else None
    if isinstance(value, (int, float)) and 1980 <= value <= 2049:
        return int(value)
    if isinstance(value, str):
        m = _YEAR_RE.search(value)
        return int(m.group(1)) if m else None
    return None


def lidar_metadata(http: Http, src: ResolvedSource, e: float, n: float, epsg: int) -> dict:
    """Best-effort collection year and project name for the data at a point.

    Uses the image service's identify call with catalog items. Year fields
    differ between services, so any attribute whose name mentions a date or
    year is considered; the newest visible item wins.
    """
    meta: dict = {"year": src.source.year, "project": None}
    params = {
        "geometry": json.dumps({"x": e, "y": n, "spatialReference": {"wkid": epsg}}),
        "geometryType": "esriGeometryPoint",
        "returnGeometry": "false",
        "returnCatalogItems": "true",
        "f": "json",
    }
    try:
        doc = http.get_json(src.source.url + "/identify", params)
    except (HttpError, ValueError) as exc:
        log.warning("identify failed for %s: %s", src.source.key, exc)
        return meta
    items = ((doc.get("catalogItems") or {}).get("features")) or []
    visible = doc.get("catalogItemVisibilities") or []
    best_year, project, raw = None, None, []
    for i, item in enumerate(items):
        if i < len(visible) and not visible[i]:
            continue
        attrs = item.get("attributes") or {}
        raw.append(attrs)
        years = [
            y
            for k, v in attrs.items()
            if re.search(r"date|year|acq|collect", k, re.I) and (y := _year_of(v)) is not None
        ]
        if years and (best_year is None or max(years) > best_year):
            best_year = max(years)
            project = next(
                (str(attrs[k]) for k in attrs if re.search(r"project|workunit|dataset|^name$", k, re.I) and attrs[k]),
                None,
            )
    if best_year and not src.source.year:
        meta["year"] = best_year
    if project:
        meta["project"] = project
    meta["identify_sample"] = raw[:3]
    return meta
