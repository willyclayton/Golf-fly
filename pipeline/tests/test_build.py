import json
import math

import numpy as np
import pytest
import yaml

import golffly.cli as cli
import golffly.locate as locate
from golffly.build import build_course
from golffly.geo import LocalFrame, m_to_yd
from golffly.package import SIZE_BUDGET_BYTES, slugify
from golffly.terrain import GridSpec, decode_heights
from synthetic import (
    COURSE_ID,
    FRAME,
    PARS,
    FakeImageServer,
    hole_nodes,
    make_course,
    overpass_stub,
    terrain_local,
    without,
)

SPEC = f"way/{COURSE_ID}"
BACK_M = {3: 150.0, 4: 360.0, 5: 470.0}


@pytest.fixture
def built(tmp_path, monkeypatch):
    monkeypatch.setattr(locate, "run_query", overpass_stub(make_course()))
    server = FakeImageServer()
    result = build_course(server, SPEC, tmp_path)
    return result, server, tmp_path


def grid_values(out_dir, entry):
    g = entry["grid"]
    payload = (out_dir / entry["file"]).read_bytes()
    values = decode_heights(payload, entry, g["rows"], g["cols"])
    spec = GridSpec(tuple(g["origin"]), math.radians(g["rotation_deg"]), g["cell_m"], g["cols"], g["rows"])
    return values, spec


def to_fixture_frame(doc, x, y):
    """Package coordinates (the course's own frame) -> the fixture's frame."""
    pkg = LocalFrame(doc["frame"]["lat0"], doc["frame"]["lon0"])
    lon, lat = pkg.to_lonlat(np.asarray(x, dtype=float), np.asarray(y, dtype=float))
    return FRAME.to_local(lon, lat)


def test_build_writes_a_complete_package(built):
    result, server, tmp = built
    assert result.ok, result.report_md
    assert result.out_dir == tmp / "synthetic-links"
    assert 0 < result.size_bytes < SIZE_BUDGET_BYTES
    doc = json.loads((result.out_dir / "course.json").read_text())
    assert doc["schema"] == "golf-fly/course@1"
    assert doc["id"] == SPEC and doc["name"] == "Synthetic Links"
    assert len(doc["holes"]) == 18
    assert doc["sources"]["osm"]["credit"] == "© OpenStreetMap contributors"
    el = doc["sources"]["elevation"]
    assert el["key"] == "usgs-3dep" and el["year"] == 2021 and el["raw_units"] == "m"
    assert [s["label"] for s in doc["tee_sets"]] == ["Blue", "White", "Red"]
    assert doc["tee_sets"][0]["total_yd"] == round(m_to_yd(4 * 150 + 10 * 360 + 4 * 470))
    for h in doc["holes"]:
        assert h["par"] == PARS[h["number"] - 1]
        assert (result.out_dir / h["terrain"]["file"]).exists()
        assert (result.out_dir / h["green_terrain"]["file"]).exists()
        assert h["green"]["confidence"] == "Low" and h["green"]["lidar_year"] == 2021
        assert h["green"]["id"] in h["feature_ids"]
        back = h["tees"][0]
        assert back["length_yd"] == pytest.approx(m_to_yd(BACK_M[h["par"]]), abs=0.15)
        assert back["sets"] == ["blue"]
    water = [f for f in doc["features"] if f["kind"] == "water"]
    assert len(water) == 2  # both drawings kept as features...
    assert len([i for i in doc["hazard_ids"] if i in {w["id"] for w in water}]) == 1  # ...but one hazard


def test_build_elevation_change_and_grids(built):
    result, _, _ = built
    doc = result.payload
    h1 = doc["holes"][0]
    # terrain rises 2% to the north; hole 1 runs 360 m north
    assert h1["tees"][0]["elev_change_ft"] == pytest.approx(0.02 * 360 / 0.3048, abs=0.2)

    values, spec = grid_values(result.out_dir, h1["terrain"])
    x, y = to_fixture_frame(doc, *spec.centers())
    assert np.isfinite(values).all()
    assert np.allclose(values, terrain_local(x, y), atol=0.02)
    assert spec.cell == 1.0 and spec.rotation == pytest.approx(math.pi / 2, abs=1e-3)

    values, spec = grid_values(result.out_dir, h1["green_terrain"])
    x, y = to_fixture_frame(doc, *spec.centers())
    assert spec.cell == 0.25
    inner = (slice(8, -8), slice(8, -8))
    assert np.allclose(values[inner], terrain_local(x, y)[inner], atol=0.005)


def test_build_marks_and_report(built):
    result, _, _ = built
    h4 = result.payload["holes"][3]
    assert [m["yd"] for m in h4["marks"]] == [100, 150, 200]
    end = hole_nodes(4)[-1]
    for m in h4["marks"]:
        x, y = to_fixture_frame(result.payload, m["point"][0], m["point"][1])
        assert math.dist((float(x), float(y)), end) == pytest.approx(m["yd"] * 0.9144, abs=0.05)
    assert "| Blue |" in result.report_md and "OpenStreetMap contributors" in result.report_md


def test_build_refuses_a_course_that_fails_the_audit(tmp_path, monkeypatch):
    green7 = hole_nodes(7)[-1]

    def is_green7(e):
        if e.get("tags", {}).get("golf") != "green":
            return False
        from synthetic import FRAME

        x, y = FRAME.to_local(e["geometry"][0]["lon"], e["geometry"][0]["lat"])
        return math.hypot(x - green7[0], y - green7[1]) < 30

    monkeypatch.setattr(locate, "run_query", overpass_stub(without(make_course(), is_green7)))
    server = FakeImageServer()
    result = build_course(server, SPEC, tmp_path)
    assert not result.ok
    assert result.audit.status == "near"
    assert "hole 7" in result.report_md
    assert server.calls == []  # no elevation requests for a course that can't ship
    assert not (tmp_path / "synthetic-links").exists()


def test_cli_build_with_scorecard(tmp_path, monkeypatch):
    monkeypatch.setattr(locate, "run_query", overpass_stub(make_course()))
    server = FakeImageServer()
    monkeypatch.setattr(cli, "Http", lambda *a, **k: server)
    cards = tmp_path / "cards"
    cards.mkdir()
    blue = [round(m_to_yd(BACK_M[p])) for p in PARS]
    white = [round(m_to_yd(BACK_M[p] - (15 if p == 3 else 30))) for p in PARS]
    (cards / f"{slugify('Synthetic Links')}.yaml").write_text(
        yaml.safe_dump({"course": "Synthetic Links", "source": "test", "par": PARS, "tees": {"Blue": blue, "White": white}})
    )
    out = tmp_path / "out"
    code = cli.main(["--no-cache", "build", SPEC, "--out", str(out), "--scorecards", str(cards)])
    assert code == 0
    check = json.loads((out / "synthetic-links" / "scorecard-check.json").read_text())
    assert check["tees"]["Blue"]["set"] == "Blue" and check["tees"]["Blue"]["max_abs"] <= 0.6
    assert check["tees"]["White"]["within_5"] == 18
    assert check["par_mismatches"] == []
    report = (out / "synthetic-links" / "build-report.md").read_text()
    assert "Scorecard check" in report
