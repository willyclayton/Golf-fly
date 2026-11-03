"""Overpass API queries for golf courses and their features.

Queries return ``out geom`` so ways and relation members carry coordinates and
no second round trip is needed. Public instances are tried in order; a 200
response whose ``remark`` reports a runtime error (Overpass's way of saying it
timed out) counts as a failure and is retried, never cached.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass

from .http import Http, HttpError, RetryableResponse

log = logging.getLogger(__name__)

ENDPOINTS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)

# Chicago Loop (State and Madison), the default centre for searches.
CHICAGO = (41.8820, -87.6278)

Bbox = tuple[float, float, float, float]  # south, west, north, east


class OverpassError(RuntimeError):
    pass


@dataclass
class OverpassResult:
    elements: list[dict]
    timestamp: str | None  # osm3s.timestamp_osm_base: the OSM data date
    endpoint: str


def _validate(body: bytes, ctype: str) -> None:
    if not body.lstrip().startswith(b"{"):
        raise RetryableResponse(f"non-JSON Overpass response: {body[:200]!r}")
    remark = json.loads(body).get("remark") or ""
    if any(s in remark for s in ("runtime error", "timed out", "out of memory", "rate_limited")):
        raise RetryableResponse(f"Overpass remark: {remark}")


def run_query(http: Http, query: str, endpoints: tuple[str, ...] = ENDPOINTS) -> OverpassResult:
    errors: list[str] = []
    for endpoint in endpoints:
        try:
            body, _ = http.fetch("POST", endpoint, data={"data": query}, validate=_validate, timeout_s=660)
        except HttpError as exc:
            log.warning("Overpass endpoint %s failed: %s", endpoint, exc)
            errors.append(f"{endpoint}: {exc}")
            continue
        doc = json.loads(body)
        elements = doc.get("elements", [])
        log.info("Overpass %s returned %d elements", endpoint, len(elements))
        return OverpassResult(elements, (doc.get("osm3s") or {}).get("timestamp_osm_base"), endpoint)
    raise OverpassError("all Overpass endpoints failed:\n" + "\n".join(errors))


def _ql_string(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def q_courses_around(lat: float, lon: float, radius_m: float) -> str:
    r = int(radius_m)
    return f"""[out:json][timeout:300];
(
  way["leisure"="golf_course"](around:{r},{lat},{lon});
  relation["leisure"="golf_course"](around:{r},{lat},{lon});
);
out geom;"""


def q_course_by_name(name: str, lat: float, lon: float, radius_m: float) -> str:
    pattern = _ql_string(re.escape(name.strip()))
    r = int(radius_m)
    return f"""[out:json][timeout:120];
(
  way["leisure"="golf_course"]["name"~{pattern},i](around:{r},{lat},{lon});
  relation["leisure"="golf_course"]["name"~{pattern},i](around:{r},{lat},{lon});
);
out geom;"""


def q_course_by_id(osm_type: str, osm_id: int) -> str:
    if osm_type not in ("way", "relation"):
        raise ValueError(f"a golf course is a way or a relation, not a {osm_type}")
    return f"""[out:json][timeout:120];
{osm_type}({osm_id});
out geom;"""


def q_golf_core(bbox: Bbox) -> str:
    """Holes, greens, tees and pins: everything the coverage audit needs."""
    s, w, n, e = bbox
    return f"""[out:json][timeout:600][maxsize:1073741824][bbox:{s:.6f},{w:.6f},{n:.6f},{e:.6f}];
(
  way["golf"="hole"];
  way["golf"="green"];
  relation["golf"="green"];
  way["golf"="tee"];
  node["golf"="tee"];
  relation["golf"="tee"];
  node["golf"="pin"];
);
out geom;"""


def q_course_features(bbox: Bbox) -> str:
    """Every feature a hole view draws: golf surfaces, water, trees, paths."""
    s, w, n, e = bbox
    return f"""[out:json][timeout:300][bbox:{s:.6f},{w:.6f},{n:.6f},{e:.6f}];
(
  nwr["golf"];
  nwr["leisure"="golf_course"];
  nwr["natural"~"^(water|wood|tree_row|tree|sand|scrub|wetland)$"];
  nwr["landuse"~"^(forest|reservoir|basin)$"];
  nwr["water"];
  way["waterway"~"^(stream|river|canal|ditch|drain|brook)$"];
  way["highway"~"^(path|footway|track|cycleway|service)$"];
);
out geom;"""


def parse_osm_ref(spec: str) -> tuple[str, int] | None:
    """Parse 'way/123', 'relation/456', 'w123', 'r456' or an osm.org URL."""
    s = spec.strip()
    m = re.search(r"(way|relation)[/ ](\d+)", s)
    if m:
        return m.group(1), int(m.group(2))
    m = re.fullmatch(r"([wr])(\d+)", s, flags=re.I)
    if m:
        return ("way" if m.group(1).lower() == "w" else "relation"), int(m.group(2))
    return None
