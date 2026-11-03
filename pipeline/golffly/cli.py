"""Command line: ``golffly survey | audit | build``."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import yaml

from .http import Http
from .overpass import CHICAGO

log = logging.getLogger("golffly")


def _summary(markdown: str) -> None:
    """Append to the GitHub Actions job summary when running in Actions."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(markdown + "\n")


def _course_specs(args) -> list[str]:
    specs = []
    for item in args.courses or []:
        specs += [s.strip() for s in item.replace("\n", ";").split(";") if s.strip()]
    if getattr(args, "file", None):
        doc = yaml.safe_load(Path(args.file).read_text()) or {}
        for entry in doc.get("courses") or []:
            if isinstance(entry, str):
                specs.append(entry)
            elif isinstance(entry, dict) and (entry.get("osm") or entry.get("name")):
                specs.append(str(entry.get("osm") or entry["name"]))
    return specs


def cmd_survey(args, http: Http) -> int:
    from .report import write_survey
    from .survey import run_survey

    lat, lon = (float(v) for v in args.center.split(","))
    result = run_survey(http, (lat, lon), args.radius_km)
    md = write_survey(result, Path(args.out))
    _summary(md)
    counts = {}
    for a in result.audits:
        counts[a.status] = counts.get(a.status, 0) + 1
    print(json.dumps({"courses": len(result.audits), "by_status": counts, "out": args.out}))
    return 0


def cmd_audit(args, http: Http) -> int:
    from .audit import audit_course
    from .course import associate
    from .locate import CourseNotFound, fetch_course
    from .report import audit_markdown, write_json
    from .survey import course_info

    specs = _course_specs(args)
    if not specs:
        print("no courses given", file=sys.stderr)
        return 2
    audits, errors, stamp = [], [], None
    for spec in specs:
        try:
            cf = fetch_course(http, spec)
        except CourseNotFound as exc:
            errors.append(str(exc))
            log.error("%s", exc)
            continue
        stamp = cf.osm_timestamp or stamp
        audits.append(audit_course(associate(cf.course, cf.golf), course_info(cf.course, cf.frame)))
    md = audit_markdown(audits, stamp)
    if errors:
        md += "\n## Not found\n\n" + "\n".join(f"- {e}" for e in errors) + "\n"
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "audit.md").write_text(md)
    write_json(out / "audit.json", {"osm_timestamp": stamp, "courses": [a.to_dict() for a in audits], "errors": errors})
    _summary(md)
    for a in audits:
        print(f"{a.status.upper():8s} {a.holes_ok:2d}/18  {a.name}  ({a.id})")
    return 0


def cmd_build(args, http: Http) -> int:
    from .build import build_course
    from .locate import CourseNotFound
    from .report import write_json
    from .scorecard import compare, compare_markdown, load_scorecard

    failed = 0
    out_root = Path(args.out)
    for spec in _course_specs(args):
        try:
            result = build_course(http, spec, out_root)
        except CourseNotFound as exc:
            log.error("%s", exc)
            _summary(f"# Not found\n\n{exc}\n")
            failed += 1
            continue
        md = result.report_md
        if result.ok:
            card_path = Path(args.scorecards) / f"{result.slug}.yaml"
            if card_path.exists():
                card = load_scorecard(card_path)
                cmp = compare(result.payload, card)
                md += "\n" + compare_markdown(card, cmp)
                write_json(result.out_dir / "scorecard-check.json", cmp)
            (result.out_dir / "build-report.md").write_text(md)
            print(f"BUILT    {result.name} -> {result.out_dir} ({result.size_bytes / 1e6:.2f} MB)")
        else:
            failed += 1
            report_dir = out_root / f"{result.slug}.not-built"
            report_dir.mkdir(parents=True, exist_ok=True)
            (report_dir / "audit.md").write_text(md)
            print(f"FAILED   {result.name}: audit {result.audit.status} ({result.audit.holes_ok}/18 holes complete)")
        _summary(md)
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="golffly", description="Course pipeline for the 3D yardage book")
    p.add_argument("-v", "--verbose", action="store_true")
    p.add_argument("--cache-dir", default=".cache/http", help="disk cache for HTTP responses")
    p.add_argument("--no-cache", action="store_true")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("survey", help="audit every OSM golf course within a radius")
    s.add_argument("--center", default=f"{CHICAGO[0]},{CHICAGO[1]}", help="lat,lon (default: the Loop)")
    s.add_argument("--radius-km", type=float, default=75.0)
    s.add_argument("--out", default="out/survey")

    a = sub.add_parser("audit", help="audit named courses")
    a.add_argument("courses", nargs="*", help="OSM ids (way/123, relation/456) or names; ';' separates several")
    a.add_argument("--file", help="YAML file with a 'courses' list")
    a.add_argument("--out", default="out/audit")

    b = sub.add_parser("build", help="build course packages")
    b.add_argument("courses", nargs="*", help="OSM ids or names; ';' separates several")
    b.add_argument("--file", help="YAML file with a 'courses' list")
    b.add_argument("--out", default="out/courses")
    b.add_argument("--scorecards", default="courses/scorecards", help="folder of <slug>.yaml scorecards")

    args = p.parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    http = Http(None if args.no_cache else args.cache_dir)
    handler = {"survey": cmd_survey, "audit": cmd_audit, "build": cmd_build}[args.command]
    try:
        return handler(args, http)
    finally:
        log.info("HTTP requests: %d (cache hits %d)", http.requests_made, http.cache_hits)


if __name__ == "__main__":
    sys.exit(main())
