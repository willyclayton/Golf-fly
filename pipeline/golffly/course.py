"""Group a region's features into courses, and tie greens, tees and pins to hole lines.

OSM draws each hole as a ``golf=hole`` line from the tee to about the middle of
the green, but greens and tees are separate polygons with no explicit link to
their hole. The links are inferred from geometry:

* green: the green polygon holding the hole line's last node, or the nearest
  one within ``GREEN_SNAP_M`` of it;
* tees: tee boxes beside the hole line's first segment, from a little behind
  its start to partway down it. Each tee goes to the single best hole.

Lines drawn backwards (green to tee) are detected and flipped.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field

import numpy as np
from shapely import STRtree
from shapely.geometry import LineString, Point

from .geo import m_to_yd
from .osm import Feature

log = logging.getLogger(__name__)

GREEN_SNAP_M = 25.0  # a hole line may end this far outside its green
TEE_MAX_OFFSET_M = 35.0  # sideways distance from the first segment
TEE_BEHIND_M = 60.0  # how far behind the line start a tee may sit
TEE_AHEAD_MAX_M = 220.0  # how far down the first segment a forward tee may sit
TEE_AHEAD_FRAC = 0.65  # ...as a fraction of the first segment
PIN_SNAP_M = 3.0
COURSE_SNAP_M = 100.0  # features just outside a course outline still belong to it

_REF_RE = re.compile(r"\s*0*(\d{1,2})\s*")
_NAME_HOLE_RE = re.compile(r"\bhole\s*(?:no\.?|#)?\s*0*(\d{1,2})\b", re.I)


def hole_number(tags: dict[str, str]) -> tuple[int | None, str | None]:
    """Hole number from ``ref`` (or a 'Hole 7' style name); returns (number, source)."""
    for key in ("ref", "golf:ref"):
        value = tags.get(key)
        if value:
            m = _REF_RE.fullmatch(value)
            if m and int(m.group(1)) > 0:
                return int(m.group(1)), key
    m = _NAME_HOLE_RE.search(tags.get("name", ""))
    if m and int(m.group(1)) > 0:
        return int(m.group(1)), "name"
    return None, None


def tag_int(tags: dict[str, str], *keys: str) -> int | None:
    for key in keys:
        value = tags.get(key)
        if value is None:
            continue
        m = re.match(r"\s*(\d+)", value)
        if m:
            return int(m.group(1))
    return None


@dataclass(eq=False)
class Hole:
    number: int
    feature: Feature
    line: LineString  # oriented tee -> green
    reversed: bool = False
    par: int | None = None
    par_source: str | None = None  # "osm", "nodes" or "length"
    handicap: int | None = None
    green: Feature | None = None
    green_gap_m: float | None = None  # 0 when the line ends inside the green
    tees: list[Feature] = field(default_factory=list)
    pins: list[Feature] = field(default_factory=list)

    @property
    def start(self) -> Point:
        return Point(self.line.coords[0])

    @property
    def end(self) -> Point:
        return Point(self.line.coords[-1])


@dataclass
class CourseData:
    course: Feature
    holes: dict[int, Hole]
    duplicate_refs: dict[int, list[Feature]]
    unnumbered: list[Feature]
    features: list[Feature]

    @property
    def name(self) -> str:
        return self.course.tags.get("name") or "(unnamed course)"

    @property
    def hole_line_count(self) -> int:
        return len(self.holes) + sum(len(v) for v in self.duplicate_refs.values()) + len(self.unnumbered)


def infer_par(line: LineString) -> tuple[int, str]:
    """Par from the OSM node convention (nodes = par - 1), sanity-checked by length."""
    length_yd = m_to_yd(line.length)
    by_length = 3 if length_yd < 250 else 4 if length_yd < 470 else 5
    by_nodes = len(line.coords) + 1
    # Straight par 4s are often drawn with two nodes, so the node rule only
    # gets a vote when it says 4 or 5 and agrees roughly with the length.
    if by_nodes in (4, 5) and abs(by_nodes - by_length) <= 1:
        return by_nodes, "nodes"
    return by_length, "length"


class _GreenIndex:
    def __init__(self, greens: list[Feature]):
        self.greens = greens
        self.tree = STRtree([g.geom for g in greens]) if greens else None

    def near(self, pt: Point, radius: float) -> list[tuple[float, Feature]]:
        if self.tree is None:
            return []
        idx = self.tree.query(pt, predicate="dwithin", distance=radius)
        return sorted(((float(self.greens[i].geom.distance(pt)), self.greens[i]) for i in idx), key=lambda t: t[0])

    def best_for(self, pt: Point, number: int) -> tuple[float | None, Feature | None]:
        cands = self.near(pt, GREEN_SNAP_M)
        if not cands:
            return None, None

        def score(c: tuple[float, Feature]):
            dist, green = c
            ref, _ = hole_number(green.tags)
            mismatch = 0 if ref == number else (2 if ref is not None else 1)
            return (dist > 0, mismatch, dist)

        dist, green = min(cands, key=score)
        return dist, green


def _near_any(tree: STRtree | None, pt: Point, radius: float) -> bool:
    return tree is not None and len(tree.query(pt, predicate="dwithin", distance=radius)) > 0


def _make_hole(number: int, feature: Feature, greens: _GreenIndex, tee_tree: STRtree | None) -> Hole:
    line: LineString = feature.geom
    start, end = Point(line.coords[0]), Point(line.coords[-1])
    # A tee often sits a few yards from the previous hole's green, so "start
    # near a green" proves nothing. Flip only on strong evidence: the line
    # starts inside a green, or ends on a tee box.
    start_in_green = greens.best_for(start, number)[0] == 0
    end_in_green = greens.best_for(end, number)[0] == 0
    start_on_tee = _near_any(tee_tree, start, 5.0)
    end_on_tee = _near_any(tee_tree, end, 5.0)
    flipped = (start_in_green and not end_in_green) or (end_on_tee and not start_on_tee and not end_in_green)
    if flipped:
        line = LineString(line.coords[::-1])
    hole = Hole(number, feature, line, reversed=flipped)
    hole.green_gap_m, hole.green = greens.best_for(hole.end, number)

    par = tag_int(feature.tags, "par", "golf:par")
    if par is not None and 3 <= par <= 6:
        hole.par, hole.par_source = par, "osm"
    else:
        hole.par, hole.par_source = infer_par(line)
    hole.handicap = tag_int(feature.tags, "handicap", "golf:handicap", "hcp")
    return hole


def _assign_tees(holes: list[Hole], tees: list[Feature]) -> None:
    segs = []
    for h in holes:
        a = np.asarray(h.line.coords[0])
        b = np.asarray(h.line.coords[1])
        length = float(np.hypot(*(b - a)))
        segs.append((a, (b - a) / length, length) if length > 1.0 else None)
    for tee in tees:
        p = np.asarray(tee.anchor.coords[0])
        ref, _ = hole_number(tee.tags)
        best, best_score = None, None
        for h, seg in zip(holes, segs):
            if seg is None:
                continue
            a, u, length = seg
            v = p - a
            along = float(v @ u)
            across = abs(float(u[0] * v[1] - u[1] * v[0]))
            ahead = min(TEE_AHEAD_FRAC * length, TEE_AHEAD_MAX_M)
            if not (-TEE_BEHIND_M <= along <= ahead and across <= TEE_MAX_OFFSET_M):
                continue
            score = across + 0.5 * max(0.0, -along)
            if ref is not None:
                score += -1000.0 if ref == h.number else 30.0
            if best_score is None or score < best_score:
                best, best_score = h, score
        if best is not None:
            best.tees.append(tee)


def _assign_pins(holes: list[Hole], pins: list[Feature]) -> None:
    for h in holes:
        if h.green is None:
            continue
        h.pins = [p for p in pins if h.green.geom.distance(p.geom) <= PIN_SNAP_M]


def associate(course: Feature, features: list[Feature]) -> CourseData:
    """Build holes for one course from the features that belong to it."""
    greens = _GreenIndex([f for f in features if f.kind == "green" and f.is_area])
    tees = [f for f in features if f.kind == "tee"]
    pins = [f for f in features if f.kind == "pin"]
    tee_tree = STRtree([t.geom for t in tees]) if tees else None

    by_ref: dict[int, list[Feature]] = {}
    unnumbered: list[Feature] = []
    for f in features:
        if f.kind != "hole" or not isinstance(f.geom, LineString):
            continue
        number, _ = hole_number(f.tags)
        if number is None:
            unnumbered.append(f)
        else:
            by_ref.setdefault(number, []).append(f)

    holes: dict[int, Hole] = {}
    duplicates: dict[int, list[Feature]] = {}
    for number, lines in sorted(by_ref.items()):
        if len(lines) == 1:
            holes[number] = _make_hole(number, lines[0], greens, tee_tree)
        else:
            duplicates[number] = lines

    hole_list = list(holes.values())
    _assign_tees(hole_list, tees)
    _assign_pins(hole_list, pins)
    return CourseData(course, holes, duplicates, unnumbered, features)


def _feature_point(f: Feature) -> Point:
    if f.kind == "hole" and isinstance(f.geom, LineString):
        return f.geom.interpolate(0.5, normalized=True)
    return f.anchor


def split_by_course(courses: list[Feature], features: list[Feature]) -> dict[str, list[Feature]]:
    """Give each feature to the smallest course outline containing it (or the nearest within 100 m)."""
    out: dict[str, list[Feature]] = {c.id: [] for c in courses}
    if not courses:
        return out
    tree = STRtree([c.geom for c in courses])
    areas = np.array([c.geom.area for c in courses])
    for f in features:
        if f.kind == "course":
            continue
        pt = _feature_point(f)
        idx = tree.query(pt, predicate="within")
        if len(idx):
            i = int(idx[np.argmin(areas[idx])])
        else:
            near = tree.query_nearest(pt, max_distance=COURSE_SNAP_M)
            if not len(near):
                continue
            i = int(near[0])
        out[courses[i].id].append(f)
    return out


def container_courses(courses: list[Feature]) -> dict[str, list[str]]:
    """Outlines that contain other course outlines (a facility drawn around its courses)."""
    out: dict[str, list[str]] = {}
    if len(courses) < 2:
        return out
    tree = STRtree([c.geom for c in courses])
    for c in courses:
        inner = []
        for i in tree.query(c.geom, predicate="contains_properly"):
            other = courses[int(i)]
            if other is not c and other.geom.area < 0.9 * c.geom.area:
                inner.append(other.id)
        if inner:
            out[c.id] = inner
    return out
