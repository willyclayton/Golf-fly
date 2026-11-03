"""Find one course in OSM (by id or name) and fetch everything on it."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from .course import split_by_course
from .geo import LocalFrame
from .http import Http
from .osm import Feature, parse_elements
from .overpass import CHICAGO, parse_osm_ref, q_course_by_id, q_course_by_name, q_course_features, run_query
from .survey import lonlat_bbox

log = logging.getLogger(__name__)

IDENTITY_KINDS = {"hole", "green", "tee", "pin"}
CONTEXT_BUFFER_M = 60.0  # hazards, trees and paths this close to the outline are kept


class CourseNotFound(RuntimeError):
    pass


@dataclass
class CourseFetch:
    course: Feature  # the outline, in the course's own frame
    frame: LocalFrame
    golf: list[Feature]  # holes, greens, tees and pins that belong to this course
    context: list[Feature]  # surfaces, hazards, trees and paths on or near it
    osm_timestamp: str | None

    @property
    def features(self) -> list[Feature]:
        return self.golf + self.context


def find_course_element(
    http: Http, spec: str, center: tuple[float, float] = CHICAGO, radius_km: float = 150.0
) -> tuple[dict, str | None]:
    ref = parse_osm_ref(spec)
    if ref:
        res = run_query(http, q_course_by_id(*ref))
        elements = [e for e in res.elements if e.get("type") == ref[0] and e.get("id") == ref[1]]
    else:
        res = run_query(http, q_course_by_name(spec, center[0], center[1], radius_km * 1000.0))
        elements = res.elements
    if not elements:
        raise CourseNotFound(f"no leisure=golf_course matching {spec!r}")
    if len(elements) > 1:
        wanted = spec.strip().lower()
        exact = [e for e in elements if (e.get("tags") or {}).get("name", "").strip().lower() == wanted]
        if len(exact) != 1:
            names = "; ".join(f"{(e.get('tags') or {}).get('name', '?')} ({e['type']}/{e['id']})" for e in elements)
            raise CourseNotFound(f"{spec!r} matches several courses, pass an OSM id instead: {names}")
        elements = exact
    return elements[0], res.timestamp


def element_center(el: dict) -> tuple[float, float]:
    b = el.get("bounds")
    if b:
        return (b["minlat"] + b["maxlat"]) / 2.0, (b["minlon"] + b["maxlon"]) / 2.0
    pts = [p for p in el.get("geometry") or [] if p]
    for m in el.get("members") or []:
        pts += [p for p in m.get("geometry") or [] if p]
    if not pts:
        raise CourseNotFound(f"{el.get('type')}/{el.get('id')} has no geometry")
    return sum(p["lat"] for p in pts) / len(pts), sum(p["lon"] for p in pts) / len(pts)


def fetch_course(http: Http, spec: str, center: tuple[float, float] = CHICAGO) -> CourseFetch:
    el, ts = find_course_element(http, spec, center)
    lat, lon = element_center(el)
    frame = LocalFrame(round(lat, 6), round(lon, 6))
    outline = [f for f in parse_elements([el], frame) if f.kind == "course" and f.is_area]
    if not outline:
        raise CourseNotFound(f"{el['type']}/{el['id']} has no usable outline polygon")
    course = outline[0]
    log.info("Course: %s (%s)", course.tags.get("name"), course.id)

    res = run_query(http, q_course_features(lonlat_bbox([course], frame, margin_m=150.0)))
    features = parse_elements(res.elements, frame)
    outlines = [f for f in features if f.kind == "course" and f.is_area and f.id != course.id] + [course]
    identity = [f for f in features if f.kind in IDENTITY_KINDS]
    golf = split_by_course(outlines, identity)[course.id]
    zone = course.geom.buffer(CONTEXT_BUFFER_M)
    context = [
        f for f in features if f.kind not in IDENTITY_KINDS and f.kind != "course" and f.geom.intersects(zone)
    ]
    log.info("%d hole/green/tee/pin features, %d other features", len(golf), len(context))
    return CourseFetch(course, frame, golf, context, res.timestamp or ts)
