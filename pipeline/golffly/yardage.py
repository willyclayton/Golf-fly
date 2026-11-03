"""Yardages along the line of play (spec: Course data pipeline, step 6).

For each tee the line of play runs from the tee, through the hole line's bend
points ahead of it, to the green middle. The approach line is the hole line's
last segment that starts outside the green; it fixes the green's front, middle
and back. Depth is the front-to-back chord along the approach line; width is
the chord through the middle at right angles to it.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, Point
from shapely.geometry.base import BaseGeometry
from shapely.ops import nearest_points

from .geo import m_to_ft, m_to_yd, yd_to_m
from .osm import Feature

HAZARD_LATERAL_YD = 40.0  # hazards this close to the line of play get carry/reach numbers
MARKS_YD = (100, 150, 200)
GREENSIDE_M = 5.0
HAZARD_DEDUPE_OVERLAP = 0.6
STREAM_HALF_WIDTH_M = 1.5

Elevation = Callable[[float, float], float]  # local x, y -> metres (NaN if unknown)


@dataclass
class GreenPoints:
    front: tuple[float, float]
    middle: tuple[float, float]
    back: tuple[float, float]
    approach_from: tuple[float, float]
    approach_index: int  # hole-line node the approach starts from
    direction: tuple[float, float]  # unit vector of the approach
    depth_m: float
    width_m: float


@dataclass
class TeeYardage:
    tee_id: str
    point: tuple[float, float]
    path: list[tuple[float, float]]
    length_yd: float
    front_yd: float
    middle_yd: float
    back_yd: float
    elev_change_ft: float | None
    hazards: list[dict] = field(default_factory=list)


def _unit(dx: float, dy: float) -> tuple[float, float]:
    n = math.hypot(dx, dy)
    return (dx / n, dy / n) if n > 0 else (0.0, 0.0)


def _intervals(origin, direction, shape: BaseGeometry, reach: float) -> list[tuple[float, float]]:
    """Stretches of a ray (as distances from its origin) that lie inside shape."""
    ox, oy = origin
    dx, dy = direction
    ray = LineString([(ox, oy), (ox + dx * reach, oy + dy * reach)])
    inter = ray.intersection(shape)
    pieces = [g for g in getattr(inter, "geoms", [inter]) if isinstance(g, LineString) and not g.is_empty]
    spans = []
    for g in pieces:
        a = ray.project(Point(g.coords[0]))
        b = ray.project(Point(g.coords[-1]))
        spans.append((min(a, b), max(a, b)))
    return sorted(spans)


def green_points(line: LineString, green: BaseGeometry) -> GreenPoints:
    coords = list(line.coords)
    idx = len(coords) - 2
    while idx > 0 and green.contains(Point(coords[idx])):
        idx -= 1
    origin = coords[idx]
    gx0, gy0, gx1, gy1 = green.bounds
    reach = math.dist(origin, coords[-1]) + math.hypot(gx1 - gx0, gy1 - gy0) + 50.0
    direction = _unit(coords[-1][0] - origin[0], coords[-1][1] - origin[1])
    spans = _intervals(origin, direction, green, reach)
    if not spans:  # line ends beside the green: aim at the green instead
        c = green.representative_point()
        direction = _unit(c.x - origin[0], c.y - origin[1])
        reach = math.dist(origin, (c.x, c.y)) + math.hypot(gx1 - gx0, gy1 - gy0) + 50.0
        spans = _intervals(origin, direction, green, reach)
    if not spans:
        raise ValueError("approach line does not cross the green")
    s_front, s_back = spans[0][0], spans[-1][1]
    s_mid = (s_front + s_back) / 2.0

    def at(s):
        return (origin[0] + direction[0] * s, origin[1] + direction[1] * s)

    middle = at(s_mid)
    perp = (-direction[1], direction[0])
    half = math.hypot(gx1 - gx0, gy1 - gy0) + 10.0
    start = (middle[0] - perp[0] * half, middle[1] - perp[1] * half)
    cross = _intervals(start, perp, green, 2 * half)
    width = 0.0
    if cross:
        width = min(cross, key=lambda span: 0 if span[0] <= half <= span[1] else min(abs(span[0] - half), abs(span[1] - half)))
        width = width[1] - width[0]
    return GreenPoints(at(s_front), middle, at(s_back), origin, idx, direction, s_back - s_front, width)


def tee_path(line: LineString, tee: tuple[float, float], gp: GreenPoints) -> LineString:
    """Line of play from a tee: bend points ahead of the tee, then the green middle."""
    coords = list(line.coords)
    s_tee = line.project(Point(tee))
    bends = [c for c in coords[1 : gp.approach_index + 1] if line.project(Point(c)) > s_tee + 1.0]
    return LineString([tee, *bends, gp.middle])


def _distance_to(path: LineString, p: tuple[float, float]) -> float:
    """Along the path to its last bend, then straight to p."""
    coords = list(path.coords)
    upto = LineString(coords[:-1]).length if len(coords) > 2 else 0.0
    return upto + math.dist(coords[-2], p)


def distance_marks(path: LineString, middle: tuple[float, float], marks_yd=MARKS_YD) -> list[dict]:
    """Points on the line of play that are 100/150/200 yd straight-line from the green middle."""
    pts = list(path.coords)[::-1]  # green -> tee
    out = []
    for yd in marks_yd:
        d = yd_to_m(yd)
        for a, b in zip(pts, pts[1:]):
            fa = (a[0] - middle[0], a[1] - middle[1])
            g = (b[0] - a[0], b[1] - a[1])
            if math.hypot(*fa) >= d or math.hypot(b[0] - middle[0], b[1] - middle[1]) < d:
                continue
            gg = g[0] ** 2 + g[1] ** 2
            fg = fa[0] * g[0] + fa[1] * g[1]
            ff = fa[0] ** 2 + fa[1] ** 2
            t = (-fg + math.sqrt(fg * fg - gg * (ff - d * d))) / gg
            out.append({"yd": yd, "point": (a[0] + t * g[0], a[1] + t * g[1])})
            break
    return out


def hazard_shape(f: Feature) -> BaseGeometry:
    return f.geom if f.is_area else f.geom.buffer(STREAM_HALF_WIDTH_M)


def hazard_family(f: Feature) -> str:
    return "bunker" if f.kind == "bunker" else "water"


def dedupe_hazards(hazards: list[Feature]) -> list[Feature]:
    """Drop hazards drawn twice (golf=water_hazard over natural=water), keeping the golf-tagged one."""
    ordered = sorted(hazards, key=lambda f: (0 if "golf" in f.tags else 1, -hazard_shape(f).area))
    shapes = [hazard_shape(f) for f in ordered]
    kept: list[int] = []
    for i, f in enumerate(ordered):
        dup = False
        if kept:
            tree = STRtree([shapes[k] for k in kept])
            for j in tree.query(shapes[i]):
                k = kept[int(j)]
                if hazard_family(ordered[k]) != hazard_family(f):
                    continue
                overlap = shapes[i].intersection(shapes[k]).area
                if overlap > HAZARD_DEDUPE_OVERLAP * min(shapes[i].area, shapes[k].area):
                    dup = True
                    break
        if not dup:
            kept.append(i)
    return [ordered[i] for i in kept]


def hazards_along(path: LineString, hazards: list[Feature], green: BaseGeometry | None) -> list[dict]:
    limit = yd_to_m(HAZARD_LATERAL_YD)
    out = []
    for hz in hazards:
        shape = hazard_shape(hz)
        offset = shape.distance(path)
        if offset > limit:
            continue
        outline = shape.boundary if shape.geom_type in ("Polygon", "MultiPolygon") else shape
        pts = shapely.get_coordinates(shapely.segmentize(outline, 1.0))
        stations = shapely.line_locate_point(path, shapely.points(pts))
        reach, carry = float(np.min(stations)), float(np.max(stations))
        if carry <= 5.0:  # behind the tee
            continue
        if shape.intersects(path):
            side = "crosses"
        else:
            p_hz, p_path = nearest_points(shape, path)
            s = path.project(p_path)
            a = path.interpolate(max(0.0, s - 0.5))
            b = path.interpolate(min(path.length, s + 0.5))
            cross = (b.x - a.x) * (p_hz.y - p_path.y) - (b.y - a.y) * (p_hz.x - p_path.x)
            side = "left" if cross > 0 else "right"
        out.append(
            {
                "feature": hz.id,
                "kind": hazard_family(hz),
                "reach_yd": round(m_to_yd(reach), 1),
                "carry_yd": round(m_to_yd(carry), 1),
                "side": side,
                "offset_yd": round(m_to_yd(offset), 1),
                "greenside": bool(green is not None and shape.distance(green) <= GREENSIDE_M),
            }
        )
    return sorted(out, key=lambda h: (h["reach_yd"], h["carry_yd"]))


def tee_yardage(
    tee_id: str,
    tee: tuple[float, float],
    line: LineString,
    gp: GreenPoints,
    hazards: list[Feature],
    green: BaseGeometry,
    elevation: Elevation | None = None,
) -> TeeYardage:
    path = tee_path(line, tee, gp)
    elev_ft = None
    if elevation is not None:
        z0, z1 = elevation(*tee), elevation(*gp.middle)
        if math.isfinite(z0) and math.isfinite(z1):
            elev_ft = round(m_to_ft(z1 - z0), 1)
    return TeeYardage(
        tee_id=tee_id,
        point=tee,
        path=[tuple(c) for c in path.coords],
        length_yd=round(m_to_yd(path.length), 1),
        front_yd=round(m_to_yd(_distance_to(path, gp.front)), 1),
        middle_yd=round(m_to_yd(path.length), 1),
        back_yd=round(m_to_yd(_distance_to(path, gp.back)), 1),
        elev_change_ft=elev_ft,
        hazards=hazards_along(path, hazards, green),
    )
