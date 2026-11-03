"""Turn Overpass elements into typed features in a local metric frame."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from shapely import make_valid
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import polygonize, unary_union

from .geo import LocalFrame

log = logging.getLogger(__name__)

# Kinds drawn as surfaces when the way is closed.
AREA_KINDS = {
    "course",
    "green",
    "tee",
    "fairway",
    "rough",
    "bunker",
    "water",
    "trees",
    "scrub",
    "wetland",
    "driving_range",
    "clubhouse",
}
HAZARD_KINDS = {"bunker", "water", "stream"}

_WATERWAYS = {"stream", "river", "canal", "ditch", "drain", "brook"}
_PATH_HIGHWAYS = {"path", "footway", "track", "cycleway"}


@dataclass(eq=False)
class Feature:
    osm_type: str
    osm_id: int
    kind: str
    tags: dict[str, str]
    geom: BaseGeometry
    truncated: bool = False  # some nodes fell outside the query box
    extra: dict = field(default_factory=dict)

    @property
    def id(self) -> str:
        return f"{self.osm_type}/{self.osm_id}"

    @property
    def is_area(self) -> bool:
        return isinstance(self.geom, (Polygon, MultiPolygon))

    @property
    def anchor(self) -> Point:
        """A point guaranteed to lie on the feature (centroid when it does)."""
        if isinstance(self.geom, Point):
            return self.geom
        c = self.geom.centroid
        if self.is_area and not self.geom.contains(c):
            return self.geom.representative_point()
        return c

    def __repr__(self) -> str:
        return f"Feature({self.kind} {self.id} {self.tags.get('ref', '')!s})"


def classify(tags: dict[str, str]) -> str | None:
    golf = tags.get("golf")
    if golf:
        mapping = {
            "hole": "hole",
            "green": "green",
            "tee": "tee",
            "pin": "pin",
            "fairway": "fairway",
            "rough": "rough",
            "bunker": "bunker",
            "water_hazard": "water",
            "lateral_water_hazard": "water",
            "cartpath": "cartpath",
            "path": "cartpath",
            "driving_range": "driving_range",
            "clubhouse": "clubhouse",
        }
        if golf in mapping:
            return mapping[golf]
    if tags.get("leisure") == "golf_course":
        return "course"
    natural = tags.get("natural")
    landuse = tags.get("landuse")
    if natural == "water" or "water" in tags or landuse in ("reservoir", "basin"):
        return "water"
    if natural == "sand":
        return "bunker"
    if natural == "wood" or landuse == "forest":
        return "trees"
    if natural == "tree_row":
        return "tree_row"
    if natural == "tree":
        return "tree"
    if natural in ("scrub", "wetland"):
        return natural
    if tags.get("waterway") in _WATERWAYS:
        return "stream"
    highway = tags.get("highway")
    if highway in _PATH_HIGHWAYS:
        return "cartpath"
    if highway == "service" and (tags.get("golf_cart") in ("yes", "designated") or tags.get("golf") == "cartpath"):
        return "cartpath"
    return None


def _way_coords(el: dict) -> tuple[list[tuple[float, float]], bool]:
    pts = el.get("geometry") or []
    coords = [(p["lon"], p["lat"]) for p in pts if p]
    return coords, len(coords) < len(pts)


def _relation_polygon(el: dict) -> tuple[BaseGeometry | None, bool]:
    outer, inner, truncated = [], [], False
    for m in el.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        coords, cut = _way_coords(m)
        truncated |= cut
        if len(coords) < 2:
            continue
        (inner if m.get("role") == "inner" else outer).append(LineString(coords))
    if not outer:
        return None, truncated
    outer_polys = list(polygonize(unary_union(outer)))
    if not outer_polys:
        return None, truncated
    shape = unary_union(outer_polys)
    if inner:
        inner_polys = list(polygonize(unary_union(inner)))
        if inner_polys:
            shape = shape.difference(unary_union(inner_polys))
    return shape, truncated


def element_to_lonlat_geometry(el: dict, kind: str) -> tuple[BaseGeometry | None, bool]:
    t = el.get("type")
    if t == "node":
        return Point(el["lon"], el["lat"]), False
    if t == "way":
        coords, truncated = _way_coords(el)
        if len(coords) < 2:
            return None, truncated
        nodes = el.get("nodes") or []
        closed = (len(nodes) > 3 and nodes[0] == nodes[-1]) or (len(coords) > 3 and coords[0] == coords[-1])
        if kind in AREA_KINDS and closed and len(coords) >= 4:
            return Polygon(coords), truncated
        return LineString(coords), truncated
    if t == "relation":
        return _relation_polygon(el)
    return None, False


def parse_elements(elements: list[dict], frame: LocalFrame) -> list[Feature]:
    """Classify and project elements; unknown or broken elements are skipped."""
    out: list[Feature] = []
    seen: set[tuple[str, int]] = set()
    for el in elements:
        key = (el.get("type"), el.get("id"))
        if key in seen:
            continue
        seen.add(key)
        tags = el.get("tags") or {}
        kind = classify(tags)
        if kind is None:
            continue
        geom, truncated = element_to_lonlat_geometry(el, kind)
        if geom is None or geom.is_empty:
            continue
        geom = frame.geom_to_local(geom)
        if not geom.is_valid:
            geom = make_valid(geom)
            if geom.geom_type == "GeometryCollection":
                polys = [g for g in geom.geoms if isinstance(g, (Polygon, MultiPolygon))]
                if not polys:
                    continue
                geom = unary_union(polys)
        out.append(Feature(el["type"], int(el["id"]), kind, dict(tags), geom, truncated))
    return out
