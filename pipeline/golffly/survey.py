"""Regional coverage survey: audit every OSM golf course within a radius.

Two Overpass queries cover the whole region (course outlines, then holes,
greens, tees and pins inside their combined box), so the survey is cheap to
rerun and gentle on the public Overpass servers.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .audit import STATUS_ORDER, CourseAudit, audit_course
from .course import associate, container_courses, split_by_course
from .geo import LocalFrame
from .http import Http
from .osm import Feature, parse_elements
from .overpass import CHICAGO, q_courses_around, q_golf_core, run_query

log = logging.getLogger(__name__)


@dataclass
class SurveyResult:
    center: tuple[float, float]
    radius_km: float
    osm_timestamp: str | None
    generated_at: str
    audits: list[CourseAudit]
    facilities: list[dict] = field(default_factory=list)  # outlines drawn around other courses


def course_info(course: Feature, frame: LocalFrame) -> dict:
    """Location and the tags that hint at public access, from a course outline."""
    pt = course.anchor
    lon, lat = frame.to_lonlat(pt.x, pt.y)
    tags = course.tags
    return {
        "lat": round(float(lat), 5),
        "lon": round(float(lon), 5),
        "distance_km": round(math.hypot(pt.x, pt.y) / 1000.0, 1),
        "access": tags.get("access"),
        "fee": tags.get("fee"),
        "operator": tags.get("operator"),
        "website": tags.get("website") or tags.get("contact:website") or tags.get("url"),
        "city": tags.get("addr:city"),
        "area_ha": round(course.geom.area / 10_000.0, 1),
    }


def lonlat_bbox(features: list[Feature], frame: LocalFrame, margin_m: float) -> tuple[float, float, float, float]:
    """(south, west, north, east) around features, padded by margin_m."""
    xs0, ys0, xs1, ys1 = zip(*(f.geom.bounds for f in features))
    xmin, ymin, xmax, ymax = min(xs0) - margin_m, min(ys0) - margin_m, max(xs1) + margin_m, max(ys1) + margin_m
    lon, lat = frame.to_lonlat([xmin, xmax, xmax, xmin], [ymin, ymin, ymax, ymax])
    return min(lat), min(lon), max(lat), max(lon)


def run_survey(http: Http, center: tuple[float, float] = CHICAGO, radius_km: float = 75.0) -> SurveyResult:
    lat, lon = center
    frame = LocalFrame(lat, lon)
    log.info("Finding golf courses within %.0f km of %.4f, %.4f", radius_km, lat, lon)
    found = run_query(http, q_courses_around(lat, lon, radius_km * 1000.0))
    courses = [f for f in parse_elements(found.elements, frame) if f.kind == "course" and f.is_area]
    log.info("%d course outlines", len(courses))
    if not courses:
        raise RuntimeError("no golf courses found; check the centre and radius")

    bbox = lonlat_bbox(courses, frame, margin_m=300.0)
    log.info("Fetching holes, greens and tees in %s", ", ".join(f"{v:.4f}" for v in bbox))
    core = run_query(http, q_golf_core(bbox))
    features = parse_elements(core.elements, frame)
    log.info("%d golf features", len(features))

    groups = split_by_course(courses, features)
    containers = container_courses(courses)
    names = {c.id: c.tags.get("name") or c.id for c in courses}

    audits: list[CourseAudit] = []
    facilities: list[dict] = []
    for course in courses:
        cd = associate(course, groups[course.id])
        if course.id in containers and cd.hole_line_count == 0:
            facilities.append(
                {
                    "id": course.id,
                    "name": cd.name,
                    "contains": [names[i] for i in containers[course.id]],
                    **course_info(course, frame),
                }
            )
            continue
        audits.append(audit_course(cd, course_info(course, frame)))

    audits.sort(key=lambda a: (STATUS_ORDER.index(a.status), a.info.get("distance_km", 0.0)))
    return SurveyResult(
        center=center,
        radius_km=radius_km,
        osm_timestamp=core.timestamp or found.timestamp,
        generated_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        audits=audits,
        facilities=facilities,
    )
