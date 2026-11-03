"""Markdown and JSON reports for surveys and audits."""

from __future__ import annotations

import json
from pathlib import Path

from .audit import MULTI, NEAR, PARTIAL, PASS, STATUS_LABEL, STATUS_ORDER, CourseAudit
from .survey import SurveyResult

OSM_URL = "https://www.openstreetmap.org/"
OSM_CREDIT = "Map data © OpenStreetMap contributors, ODbL."


def _md(s: str) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


def osm_link(name: str, osm_id: str) -> str:
    return f"[{_md(name)}]({OSM_URL}{osm_id})"


def is_private(a: CourseAudit) -> bool:
    return (a.info.get("access") or "").lower() in ("private", "members", "no", "customers_only")


def _tees(a: CourseAudit) -> str:
    counts = [h.tee_count for h in a.holes if h.has_line]
    if not counts:
        return "-"
    lo, hi = min(counts), max(counts)
    return str(lo) if lo == hi else f"{lo}-{hi}"


def _km(a: CourseAudit) -> str:
    d = a.info.get("distance_km")
    return "-" if d is None else f"{d:.0f}"


def _table(header: list[str], rows: list[list[str]]) -> list[str]:
    out = ["| " + " | ".join(header) + " |", "|" + "|".join(" --- " for _ in header) + "|"]
    out += ["| " + " | ".join(_md(c) if not c.startswith("[") else c for c in row) + " |" for row in rows]
    return out + [""]


def _status_section(status: str, group: list[CourseAudit]) -> list[str]:
    lines = [f"## {STATUS_LABEL[status]} ({len(group)})", ""]
    if status == PASS:
        rows = [
            [osm_link(a.name, a.id), _km(a), str(a.par or "?"), _tees(a), a.info.get("access") or "-", a.info.get("city") or "-"]
            for a in group
        ]
        lines += _table(["Course", "km", "Par", "Tees per hole", "Access tag", "City"], rows)
    elif status in (NEAR, PARTIAL):
        rows = [[osm_link(a.name, a.id), _km(a), f"{a.holes_ok}/18", "; ".join(a.problems)] for a in group]
        lines += _table(["Course", "km", "Holes OK", "What's missing"], rows)
    elif status == MULTI:
        rows = [[osm_link(a.name, a.id), _km(a), str(a.hole_lines), "; ".join(a.problems)] for a in group]
        lines += _table(["Course", "km", "Hole lines", "Notes"], rows)
    else:
        rows = [[osm_link(a.name, a.id), _km(a), str(a.hole_lines)] for a in group]
        lines += _table(["Course", "km", "Hole lines"], rows)
    return lines


def survey_markdown(s: SurveyResult) -> str:
    public = [a for a in s.audits if not is_private(a)]
    private = [a for a in s.audits if is_private(a)]
    lines = [
        "# Course coverage survey",
        "",
        f"Golf courses in OpenStreetMap within {s.radius_km:.0f} km of {s.center[0]:.4f}, {s.center[1]:.4f}. "
        f"OSM data as of {s.osm_timestamp or 'unknown'}; generated {s.generated_at}.",
        "",
        "A course passes when all 18 holes have a hole line, a green polygon and at least one tee. "
        "Distances (km) are straight-line from the centre. Green fees and public access are not in OSM "
        "reliably, so check those by hand.",
        "",
    ]
    counts = [[STATUS_LABEL[st], str(sum(1 for a in public if a.status == st))] for st in STATUS_ORDER]
    counts.append(["Tagged private in OSM", str(len(private))])
    lines += _table(["Status", "Courses"], counts)
    for status in STATUS_ORDER:
        group = [a for a in public if a.status == status]
        if group:
            lines += _status_section(status, group)
    if private:
        lines += [f"## Tagged private in OSM ({len(private)})", ""]
        rows = [[osm_link(a.name, a.id), _km(a), a.status] for a in private]
        lines += _table(["Course", "km", "Audit"], rows)
    if s.facilities:
        lines += [f"## Facility outlines drawn around other courses ({len(s.facilities)})", ""]
        rows = [[osm_link(f["name"], f["id"]), "; ".join(f["contains"])] for f in s.facilities]
        lines += _table(["Outline", "Contains"], rows)
    lines += [OSM_CREDIT, ""]
    return "\n".join(lines)


def audit_markdown(audits: list[CourseAudit], osm_timestamp: str | None) -> str:
    lines = ["# Course audit", "", f"OSM data as of {osm_timestamp or 'unknown'}.", ""]
    for a in audits:
        lines += [
            f"## {_md(a.name)}: {a.status.upper()}",
            "",
            f"{osm_link(a.id, a.id)} · {a.hole_lines} hole lines · {a.holes_ok}/18 holes complete"
            + (f" · par {a.par}" if a.par else ""),
            "",
        ]
        if a.problems:
            lines += [f"- {_md(p)}" for p in a.problems] + [""]
        rows = []
        for h in a.holes:
            par = "-" if h.par is None else f"{h.par}" + ("" if h.par_source == "osm" else "*")
            rows.append(
                [
                    str(h.number),
                    par,
                    "-" if h.length_yd is None else f"{h.length_yd:.0f}",
                    "yes" if h.has_green else "no",
                    str(h.tee_count),
                    "; ".join(h.problems) or ("ok (line drawn green-to-tee, flipped)" if h.reversed else "ok"),
                ]
            )
        lines += _table(["Hole", "Par", "Line yd", "Green", "Tees", "Status"], rows)
    lines += ["\\* par inferred from the hole line, not tagged in OSM.", "", OSM_CREDIT, ""]
    return "\n".join(lines)


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1, ensure_ascii=False))


def write_survey(s: SurveyResult, out_dir: Path) -> str:
    out_dir.mkdir(parents=True, exist_ok=True)
    md = survey_markdown(s)
    (out_dir / "survey.md").write_text(md)
    write_json(
        out_dir / "survey.json",
        {
            "center": s.center,
            "radius_km": s.radius_km,
            "osm_timestamp": s.osm_timestamp,
            "generated_at": s.generated_at,
            "courses": [a.to_dict() for a in s.audits],
            "facilities": s.facilities,
        },
    )
    return md
