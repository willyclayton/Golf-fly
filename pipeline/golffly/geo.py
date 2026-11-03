"""Coordinate frames, units and small geometry helpers.

All pipeline geometry lives in a local transverse Mercator frame centred on the
course: x east, y north, in metres. With the scale factor fixed at 1 on the
central meridian, the scale error a few kilometres out is under a millimetre
per kilometre, so distances in this frame are ground distances for yardage
purposes. The frame's proj string is written into each course package so the
app can project GPS fixes into the same frame.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import cached_property

import numpy as np
import shapely
from pyproj import CRS, Transformer
from shapely.geometry.base import BaseGeometry

M_PER_YD = 0.9144
M_PER_FT = 0.3048
WGS84 = "EPSG:4326"


def m_to_yd(m: float) -> float:
    return m / M_PER_YD


def yd_to_m(yd: float) -> float:
    return yd * M_PER_YD


def m_to_ft(m: float) -> float:
    return m / M_PER_FT


def utm_epsg(lon: float, lat: float) -> int:
    """EPSG code of the WGS84 UTM zone containing a point (Chicago: 32616)."""
    zone = int((lon + 180.0) // 6.0) + 1
    return (32600 if lat >= 0 else 32700) + zone


@dataclass(frozen=True)
class LocalFrame:
    """Transverse Mercator frame with its origin at (lat0, lon0)."""

    lat0: float
    lon0: float

    @property
    def proj4(self) -> str:
        return (
            f"+proj=tmerc +lat_0={self.lat0:.7f} +lon_0={self.lon0:.7f} +k=1 "
            "+x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs"
        )

    @cached_property
    def crs(self) -> CRS:
        return CRS.from_proj4(self.proj4)

    @cached_property
    def utm_epsg(self) -> int:
        return utm_epsg(self.lon0, self.lat0)

    @cached_property
    def _from_wgs84(self) -> Transformer:
        return Transformer.from_crs(WGS84, self.crs, always_xy=True)

    @cached_property
    def _to_wgs84(self) -> Transformer:
        return Transformer.from_crs(self.crs, WGS84, always_xy=True)

    @cached_property
    def _to_utm(self) -> Transformer:
        return Transformer.from_crs(self.crs, f"EPSG:{self.utm_epsg}", always_xy=True)

    @cached_property
    def _from_utm(self) -> Transformer:
        return Transformer.from_crs(f"EPSG:{self.utm_epsg}", self.crs, always_xy=True)

    def to_local(self, lon, lat):
        return self._from_wgs84.transform(lon, lat)

    def to_lonlat(self, x, y):
        return self._to_wgs84.transform(x, y)

    def to_utm(self, x, y):
        return self._to_utm.transform(x, y)

    def from_utm(self, e, n):
        return self._from_utm.transform(e, n)

    def geom_to_local(self, geom: BaseGeometry) -> BaseGeometry:
        """Project a lon/lat geometry into this frame."""
        return shapely.transform(geom, lambda c: np.column_stack(self.to_local(c[:, 0], c[:, 1])))

    def geom_to_lonlat(self, geom: BaseGeometry) -> BaseGeometry:
        return shapely.transform(geom, lambda c: np.column_stack(self.to_lonlat(c[:, 0], c[:, 1])))

    def bounds_to_utm(self, bounds: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
        """Axis-aligned UTM box that contains a local-frame box (corners plus edge midpoints)."""
        xmin, ymin, xmax, ymax = bounds
        xs = np.array([xmin, xmax, xmax, xmin, (xmin + xmax) / 2, (xmin + xmax) / 2, xmin, xmax])
        ys = np.array([ymin, ymin, ymax, ymax, ymin, ymax, (ymin + ymax) / 2, (ymin + ymax) / 2])
        e, n = self.to_utm(xs, ys)
        return float(np.min(e)), float(np.min(n)), float(np.max(e)), float(np.max(n))


def heading(a, b) -> float:
    """Angle (radians, counter-clockwise from east) of the vector a -> b."""
    return math.atan2(b[1] - a[1], b[0] - a[0])


def rotate(x, y, theta: float):
    """Rotate points counter-clockwise by theta about the origin."""
    c, s = math.cos(theta), math.sin(theta)
    return x * c - y * s, x * s + y * c


def bearing_deg(theta: float) -> float:
    """Compass bearing (degrees clockwise from north) of a local-frame heading."""
    return (90.0 - math.degrees(theta)) % 360.0
