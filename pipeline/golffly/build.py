"""Build one course package (spec: Course data pipeline, steps 1-7)."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from shapely import STRtree
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from . import __version__
from .audit import CourseAudit, audit_course
from .course import Hole, associate
from .elevation import ResolvedSource, choose_source, fetch_raster, lidar_metadata
from .geo import LocalFrame, bearing_deg, heading, m_to_yd
from .http import Http
from .locate import CourseFetch, fetch_course
from .osm import HAZARD_KINDS
from .overpass import CHICAGO
from .package import SCHEMA, SIZE_BUDGET_BYTES, feature_json, geom_json, round_xy, slugify, write_package
from .report import OSM_CREDIT, audit_markdown
from .survey import course_info
from .teesets import build_tee_sets, tee_labels
from .terrain import (
    GridSpec,
    encode_heights,
    fill_gaps,
    gaussian_smooth,
    grid_utm_bounds,
    oriented_grid,
    sample_grid,
)
from .yardage import GreenPoints, TeeYardage, dedupe_hazards, distance_marks, green_points, tee_yardage

log = logging.getLogger(__name__)

COURSE_BUFFER_M = 50.0  # elevation pulled for the course area plus this buffer
CORRIDOR_PAD_M = 50.0  # hole grid reaches this far beyond the line of play, tees and green
HOLE_CELL_M = 1.0
GREEN_CELL_M = 0.25
GREEN_APRON_M = 10.0
GREEN_SMOOTH_SIGMA_M = 0.5  # Gaussian sigma: "smoothed over about 1 m"
HOLE_STEP_M = 0.01  # height quantisation
GREEN_STEP_M = 0.001


@dataclass
class HoleBuild:
    hole: Hole
    gp: GreenPoints
    tees: list[TeeYardage]
    marks: list[dict]
    hole_grid: GridSpec | None = None
    green_grid: GridSpec | None = None
    files: dict = field(default_factory=dict)


@dataclass
class BuildResult:
    ok: bool
    slug: str
    name: str
    audit: CourseAudit
    out_dir: Path | None = None
    size_bytes: int = 0
    report_md: str = ""
    warnings: list[str] = field(default_factory=list)
    payload: dict | None = None


def _corridor(hb: HoleBuild):
    parts = [LineString(t.path) for t in hb.tees] + [hb.hole.green.geom] + [t.geom for t in hb.hole.tees]
    return unary_union(parts)


def _grid_polygon(spec: GridSpec) -> Polygon:
    x, y = spec.centers()
    return Polygon([(x[0, 0], y[0, 0]), (x[0, -1], y[0, -1]), (x[-1, -1], y[-1, -1]), (x[-1, 0], y[-1, 0])])


def build_course(
    http: Http,
    spec: str,
    out_root: Path,
    center: tuple[float, float] = CHICAGO,
) -> BuildResult:
    cf: CourseFetch = fetch_course(http, spec, center)
    frame: LocalFrame = cf.frame
    cd = associate(cf.course, cf.golf)
    info = course_info(cf.course, frame)
    info.pop("distance_km", None)
    audit = audit_course(cd, info)
    slug = slugify(cd.name)
    if not audit.passed:
        md = audit_markdown([audit], cf.osm_timestamp)
        return BuildResult(False, slug, cd.name, audit, report_md="# Not built: audit failed\n\n" + md)

    holes = [cd.holes[n] for n in range(1, 19)]
    hazards = dedupe_hazards([f for f in cf.context if f.kind in HAZARD_KINDS])
    warnings: list[str] = []

    # --- elevation ---------------------------------------------------------
    extent = unary_union(
        [cf.course.geom] + [h.line for h in holes] + [h.green.geom for h in holes] + [t.geom for h in holes for t in h.tees]
    )
    xmin, ymin, xmax, ymax = extent.bounds
    bbox_utm = frame.bounds_to_utm(
        (xmin - COURSE_BUFFER_M, ymin - COURSE_BUFFER_M, xmax + COURSE_BUFFER_M, ymax + COURSE_BUFFER_M)
    )
    epsg = frame.utm_epsg
    src: ResolvedSource = choose_source(http, bbox_utm, epsg)
    log.info("Elevation: %s (raw units %s)", src.source.name, src.units)
    course_raster = fetch_raster(http, src, bbox_utm, HOLE_CELL_M, epsg)
    if course_raster.coverage < 0.98:
        warnings.append(f"elevation covers {course_raster.coverage:.1%} of the course box")
    ce, cn = frame.to_utm(0.0, 0.0)
    lidar = lidar_metadata(http, src, float(ce), float(cn), epsg)

    def z(x: float, y: float) -> float:
        e, n = frame.to_utm(x, y)
        return float(course_raster.sample([e], [n])[0])

    # --- yardages and grids per hole ----------------------------------------
    builds: list[HoleBuild] = []
    blobs: dict[str, bytes] = {}
    for h in holes:
        gp = green_points(h.line, h.green.geom)
        tees = [tee_yardage(t.id, tuple(t.anchor.coords[0]), h.line, gp, hazards, h.green.geom, z) for t in h.tees]
        back = max(tees, key=lambda t: t.length_yd)
        hb = HoleBuild(h, gp, tees, distance_marks(LineString(back.path), gp.middle))

        rotation = heading(back.point, gp.middle)
        hb.hole_grid = oriented_grid(_corridor(hb), rotation, HOLE_CELL_M, CORRIDOR_PAD_M)
        hole_vals = fill_gaps(sample_grid(hb.hole_grid, course_raster, frame))
        data, header = encode_heights(hole_vals, HOLE_STEP_M)
        name = f"holes/{h.number:02d}-terrain.bin"
        blobs[name] = data
        hb.files["terrain"] = {"file": name, "grid": hb.hole_grid.to_json(), **header}

        green_rotation = math.atan2(gp.direction[1], gp.direction[0])
        hb.green_grid = oriented_grid(h.green.geom, green_rotation, GREEN_CELL_M, GREEN_APRON_M)
        green_raster = fetch_raster(http, src, grid_utm_bounds(hb.green_grid, frame, 2.0), GREEN_CELL_M, epsg)
        green_vals = gaussian_smooth(
            fill_gaps(sample_grid(hb.green_grid, green_raster, frame)), GREEN_SMOOTH_SIGMA_M / GREEN_CELL_M
        )
        data, header = encode_heights(green_vals, GREEN_STEP_M)
        name = f"holes/{h.number:02d}-green.bin"
        blobs[name] = data
        hb.files["green"] = {
            "file": name,
            "grid": hb.green_grid.to_json(),
            "smoothing_sigma_m": GREEN_SMOOTH_SIGMA_M,
            **header,
        }
        if header["valid_fraction"] < 0.99:
            warnings.append(f"hole {h.number}: green grid has {1 - header['valid_fraction']:.1%} no-data cells")
        builds.append(hb)
        log.info("hole %d: %s", h.number, ", ".join(f"{t.length_yd:.0f}" for t in tees))

    lengths_m = {t.tee_id: t.length_yd * 0.9144 for hb in builds for t in hb.tees}
    tee_sets = build_tee_sets({hb.hole.number: hb.hole.tees for hb in builds}, lengths_m)

    payload = _payload(cf, cd.name, slug, audit, src, lidar, builds, tee_sets, hazards)
    out_dir = out_root / slug
    size = write_package(out_dir, payload, blobs)
    if size > SIZE_BUDGET_BYTES:
        warnings.append(f"package is {size / 1e6:.1f} MB, over the 5 MB budget")
    result = BuildResult(True, slug, cd.name, audit, out_dir, size, warnings=warnings, payload=payload)
    result.report_md = build_markdown(result)
    return result


def _payload(cf, name, slug, audit, src, lidar, builds, tee_sets, hazards) -> dict:
    frame = cf.frame
    sets_by_tee: dict[str, list[str]] = {}
    for s in tee_sets:
        for tee_id in s.tees.values():
            sets_by_tee.setdefault(tee_id, []).append(s.key)

    features = [f for f in cf.features if f.kind != "course"]
    tree = STRtree([f.geom for f in features]) if features else None
    holes_json = []
    for hb in builds:
        h, gp = hb.hole, hb.gp
        ids = []
        if tree is not None:
            ids = sorted({features[int(i)].id for i in tree.query(_grid_polygon(hb.hole_grid), predicate="intersects")})
        holes_json.append(
            {
                "number": h.number,
                "par": h.par,
                "par_source": h.par_source,
                "handicap": h.handicap,
                "osm_id": h.feature.id,
                "line": [round_xy(c) for c in h.line.coords],
                "bearing_deg": round(bearing_deg(heading(h.line.coords[0], gp.middle)), 1),
                "green": {
                    "id": h.green.id,
                    "front": round_xy(gp.front),
                    "middle": round_xy(gp.middle),
                    "back": round_xy(gp.back),
                    "approach_from": round_xy(gp.approach_from),
                    "depth_yd": round(m_to_yd(gp.depth_m), 1),
                    "width_yd": round(m_to_yd(gp.width_m), 1),
                    "confidence": src.source.confidence,
                    "lidar_year": lidar.get("year"),
                    "pins": [round_xy(p.geom.coords[0]) for p in h.pins],
                },
                "tees": [
                    {
                        "id": t.tee_id,
                        "labels": tee_labels(next(f.tags for f in h.tees if f.id == t.tee_id)),
                        "sets": sets_by_tee.get(t.tee_id, []),
                        "point": round_xy(t.point),
                        "path": [round_xy(c) for c in t.path],
                        "length_yd": t.length_yd,
                        "front_yd": t.front_yd,
                        "middle_yd": t.middle_yd,
                        "back_yd": t.back_yd,
                        "elev_change_ft": t.elev_change_ft,
                        "hazards": t.hazards,
                    }
                    for t in sorted(hb.tees, key=lambda t: -t.length_yd)
                ],
                "marks": [{"yd": m["yd"], "point": round_xy(m["point"])} for m in hb.marks],
                "feature_ids": ids,
                "terrain": hb.files["terrain"],
                "green_terrain": hb.files["green"],
            }
        )

    xmin, ymin, xmax, ymax = cf.course.geom.bounds
    lon, lat = frame.to_lonlat([xmin, xmax], [ymin, ymax])
    return {
        "schema": SCHEMA,
        "id": cf.course.id,
        "name": name,
        "slug": slug,
        "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pipeline_version": __version__,
        "sources": {
            "osm": {"timestamp": cf.osm_timestamp, "license": "ODbL-1.0", "credit": "© OpenStreetMap contributors"},
            "elevation": {
                "key": src.source.key,
                "name": src.source.name,
                "quality": src.source.quality,
                "confidence": src.source.confidence,
                "year": lidar.get("year"),
                "project": lidar.get("project"),
                "url": src.source.url,
                "credit": src.source.credit,
                "raw_units": src.units,
                "coverage": round(src.coverage, 4),
            },
        },
        "frame": {"proj4": frame.proj4, "lat0": frame.lat0, "lon0": frame.lon0, "units": "m"},
        "bounds": {
            "local": [round(xmin, 1), round(ymin, 1), round(xmax, 1), round(ymax, 1)],
            "lonlat": [round(min(lon), 6), round(min(lat), 6), round(max(lon), 6), round(max(lat), 6)],
        },
        "outline": geom_json(cf.course.geom),
        "info": audit.info,
        "tee_sets": [
            {
                "key": s.key,
                "label": s.label,
                "source": s.source,
                "total_yd": s.total_yd,
                "tees": {str(n): t for n, t in sorted(s.tees.items())},
                "fallback_holes": s.fallback_holes,
            }
            for s in tee_sets
        ],
        "holes": holes_json,
        "features": [feature_json(f) for f in features],
        "hazard_ids": [f.id for f in hazards],
    }


def _hole_length(payload_hole: dict, tee_id: str) -> float | None:
    for t in payload_hole["tees"]:
        if t["id"] == tee_id:
            return t["length_yd"]
    return None


def build_markdown(r: BuildResult) -> str:
    p = r.payload
    el = p["sources"]["elevation"]
    sets = p["tee_sets"]
    lines = [
        f"# {p['name']}",
        "",
        f"OSM [{p['id']}](https://www.openstreetmap.org/{p['id']}) · OSM data {p['sources']['osm']['timestamp']} · "
        f"elevation: {el['name']} ({el['quality']}, {el.get('year') or 'year unknown'}, raw units {el['raw_units']}) · "
        f"package {r.size_bytes / 1e6:.2f} MB",
        "",
    ]
    if r.warnings:
        lines += [f"- warning: {w}" for w in r.warnings] + [""]
    lines += ["| Tee set | Yards | From | Borrowed tees on holes |", "| --- | --- | --- | --- |"]
    for s in sets:
        fb = ", ".join(str(n) for n in s["fallback_holes"]) or "-"
        lines.append(f"| {s['label']} | {s['total_yd']:.0f} | {s['source']} | {fb} |")
    lines.append("")
    header = ["Hole", "Par", "Hcp"] + [s["label"] for s in sets] + ["Green F/M/B", "Depth x width", "Elev ft", "Hazards"]
    lines += ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    for h in p["holes"]:
        back = h["tees"][0]
        row = [str(h["number"]), f"{h['par']}{'' if h['par_source'] == 'osm' else '*'}", str(h["handicap"] or "-")]
        for s in sets:
            v = _hole_length(h, s["tees"].get(str(h["number"]), ""))
            row.append("-" if v is None else f"{v:.0f}")
        row += [
            f"{back['front_yd']:.0f}/{back['middle_yd']:.0f}/{back['back_yd']:.0f}",
            f"{h['green']['depth_yd']:.0f} x {h['green']['width_yd']:.0f}",
            "-" if back["elev_change_ft"] is None else f"{back['elev_change_ft']:+.0f}",
            str(len(back["hazards"])),
        ]
        lines.append("| " + " | ".join(row) + " |")
    lines += [
        "",
        "Green F/M/B, elevation change and hazard count are from the longest tee. "
        "\\* par inferred from the hole line, not tagged in OSM.",
        "",
        OSM_CREDIT + f" Elevation: {el['credit']}.",
        "",
    ]
    return "\n".join(lines)
