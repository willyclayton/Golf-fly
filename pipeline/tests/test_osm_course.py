import math
from copy import deepcopy

import pytest
from shapely.geometry import LineString, Polygon

import golffly.survey as survey_mod
from golffly.audit import MULTI, NEAR, NINE, OUTLINE, PARTIAL, PASS, audit_course
from golffly.course import associate, hole_number, infer_par, split_by_course
from golffly.geo import LocalFrame, m_to_yd
from golffly.osm import classify, parse_elements
from golffly.overpass import OverpassResult, parse_osm_ref
from golffly.report import survey_markdown
from synthetic import (
    COURSE_ID,
    FRAME,
    PARS,
    ElementFactory,
    circle,
    course_element,
    hole_nodes,
    hole_ref,
    lane_x,
    make_course,
    without,
)


def course_data(elements, frame=FRAME):
    feats = parse_elements(elements, frame)
    course = next(f for f in feats if f.kind == "course")
    return associate(course, [f for f in feats if f.kind != "course"])


# --- parsing -----------------------------------------------------------------


@pytest.mark.parametrize(
    "tags,kind",
    [
        ({"golf": "hole"}, "hole"),
        ({"golf": "lateral_water_hazard"}, "water"),
        ({"natural": "water", "water": "pond"}, "water"),
        ({"natural": "sand"}, "bunker"),
        ({"landuse": "forest"}, "trees"),
        ({"natural": "tree_row"}, "tree_row"),
        ({"waterway": "stream"}, "stream"),
        ({"highway": "path"}, "cartpath"),
        ({"highway": "service"}, None),
        ({"highway": "service", "golf_cart": "designated"}, "cartpath"),
        ({"leisure": "golf_course"}, "course"),
        ({"building": "yes"}, None),
    ],
)
def test_classify(tags, kind):
    assert classify(tags) == kind


def test_parse_polygons_lines_and_points():
    feats = {f.id: f for f in parse_elements(make_course(), FRAME)}
    course = feats[f"way/{COURSE_ID}"]
    assert course.kind == "course" and isinstance(course.geom, Polygon)
    holes = [f for f in feats.values() if f.kind == "hole"]
    assert len(holes) == 18 and all(isinstance(h.geom, LineString) for h in holes)
    # projected back into the local frame to within millimetres
    h1 = next(h for h in holes if h.tags["ref"] == "1")
    assert h1.geom.coords[0] == pytest.approx(hole_nodes(1)[0], abs=0.005)
    assert any(f.kind == "pin" for f in feats.values())


def test_relation_multipolygon_with_inner_ring():
    f = ElementFactory()
    outer = f.way(circle(0, 0, 50), {}, closed=True)
    inner = f.way(circle(0, 0, 10), {}, closed=True)
    rel = {
        "type": "relation",
        "id": 77,
        "tags": {"type": "multipolygon", "golf": "green"},
        "members": [
            {"type": "way", "ref": outer["id"], "role": "outer", "geometry": outer["geometry"]},
            {"type": "way", "ref": inner["id"], "role": "inner", "geometry": inner["geometry"]},
        ],
    }
    [green] = parse_elements([rel], FRAME)
    assert green.kind == "green"
    assert green.geom.area == pytest.approx(math.pi * (50**2 - 10**2), rel=0.01)


def test_truncated_way_is_flagged():
    f = ElementFactory()
    el = f.way(circle(0, 0, 20), {"golf": "green"}, closed=True)
    el["geometry"][3] = None
    [green] = parse_elements([el], FRAME)
    assert green.truncated


@pytest.mark.parametrize(
    "spec,expected",
    [
        ("way/123", ("way", 123)),
        ("relation/456", ("relation", 456)),
        ("w123", ("way", 123)),
        ("R9", ("relation", 9)),
        ("https://www.openstreetmap.org/way/42#map=17", ("way", 42)),
        ("Cog Hill", None),
    ],
)
def test_parse_osm_ref(spec, expected):
    assert parse_osm_ref(spec) == expected


def test_hole_number_sources():
    assert hole_number({"ref": "07"}) == (7, "ref")
    assert hole_number({"name": "Hole #12"}) == (12, "name")
    assert hole_number({"ref": "A"}) == (None, None)


def test_infer_par():
    straight_300 = LineString([(0, 0), (0, 300)])
    assert infer_par(straight_300) == (4, "length")
    three_nodes_200 = LineString([(0, 0), (0, 100), (0, 200)])
    assert infer_par(three_nodes_200) == (4, "nodes")
    assert infer_par(LineString([(0, 0), (0, 300), (100, 400), (100, 500)]))[0] == 5


# --- association ---------------------------------------------------------------


def test_associate_full_course():
    cd = course_data(make_course())
    assert sorted(cd.holes) == list(range(1, 19))
    for n, h in cd.holes.items():
        assert h.green is not None and h.green_gap_m == 0
        assert len(h.tees) == 3, f"hole {n}"
        assert h.par == PARS[n - 1] and h.par_source == "osm"
        assert len(h.pins) == 1
        assert not h.reversed


def test_reversed_hole_line_is_flipped():
    elements = make_course()
    for e in elements:
        if hole_ref(e) == 5:
            e["geometry"].reverse()
            e["nodes"].reverse()
    cd = course_data(elements)
    h = cd.holes[5]
    assert h.reversed
    assert h.line.coords[0] == pytest.approx(hole_nodes(5)[0], abs=0.01)
    assert audit_course(cd).status == PASS


def test_tee_near_previous_green_does_not_flip():
    # Hole 2 loses its own green, and some other green sits 10 m from its tee.
    green2 = hole_nodes(2)[-1]
    elements = without(
        make_course(),
        lambda e: e.get("tags", {}).get("golf") == "green"
        and abs(e["bounds"]["maxlat"] - e["bounds"]["minlat"]) < 1
        and _near(e, green2),
    )
    f = ElementFactory()
    f.way(circle(lane_x(2), -20.0, 10.0), {"golf": "green"}, closed=True)
    cd = course_data(elements + f.elements)
    assert not cd.holes[2].reversed
    assert cd.holes[2].green is None


def _near(el, pt, tol=30.0):
    x, y = FRAME.to_local(el["geometry"][0]["lon"], el["geometry"][0]["lat"])
    return math.hypot(x - pt[0], y - pt[1]) < tol


# --- audit ----------------------------------------------------------------------


def test_audit_pass():
    a = audit_course(course_data(make_course()))
    assert a.status == PASS and a.passed
    assert a.holes_ok == 18 and a.par == 72
    assert a.holes[0].length_yd == pytest.approx(m_to_yd(360.0), abs=0.1)


def test_audit_near_miss_names_the_hole():
    green7 = hole_nodes(7)[-1]
    elements = without(make_course(), lambda e: e.get("tags", {}).get("golf") == "green" and _near(e, green7))
    a = audit_course(course_data(elements))
    assert a.status == NEAR
    assert a.holes_ok == 17
    assert any("no green polygon" in p and "hole 7" in p for p in a.problems)


def test_audit_partial():
    ends = [hole_nodes(n)[-1] for n in range(1, 6)]
    elements = without(
        make_course(), lambda e: e.get("tags", {}).get("golf") == "green" and any(_near(e, p) for p in ends)
    )
    a = audit_course(course_data(elements))
    assert a.status == PARTIAL
    assert any("holes 1-5" in p for p in a.problems)


def test_audit_nine_hole_layout():
    elements = without(make_course(), lambda e: (hole_ref(e) or 0) > 9)
    assert audit_course(course_data(elements)).status == NINE


def test_audit_outline_only():
    elements = without(make_course(), lambda e: e.get("tags", {}).get("golf") == "hole")
    assert audit_course(course_data(elements)).status == OUTLINE


def test_audit_duplicate_numbers_is_multi_course():
    elements = make_course()
    extra = [deepcopy(e) for e in elements if hole_ref(e) is not None]
    for i, e in enumerate(extra):
        e["id"] = 50_000 + i
    a = audit_course(course_data(elements + extra))
    assert a.status == MULTI
    assert any("more than one hole line" in p for p in a.problems)


# --- survey -----------------------------------------------------------------------


def test_split_by_course_prefers_the_smallest_outline():
    frame = LocalFrame(41.70, -87.90)
    elements = make_course()
    f = ElementFactory()
    f.way(
        [(-2000, -1000), (2000, -1000), (2000, 1500), (-2000, 1500), (-2000, -1000)],
        {"leisure": "golf_course", "name": "Big Facility"},
        closed=True,
        way_id=990_001,
    )
    feats = parse_elements(elements + f.elements, frame)
    courses = [x for x in feats if x.kind == "course"]
    groups = split_by_course(courses, [x for x in feats if x.kind != "course"])
    small = next(c for c in courses if c.tags["name"] != "Big Facility")
    big = next(c for c in courses if c.tags["name"] == "Big Facility")
    assert len(groups[big.id]) == 0
    assert sum(1 for x in groups[small.id] if x.kind == "hole") == 18


def test_survey_end_to_end(monkeypatch):
    elements = make_course()
    calls = []

    def fake_run_query(http, query, endpoints=None):
        calls.append(query)
        if "around:" in query:
            return OverpassResult([course_element(elements)], "2026-11-01T00:00:00Z", "stub")
        return OverpassResult(elements, "2026-11-01T00:00:00Z", "stub")

    monkeypatch.setattr(survey_mod, "run_query", fake_run_query)
    result = survey_mod.run_survey(http=None, center=(41.8820, -87.6278), radius_km=75)
    assert len(calls) == 2
    [a] = result.audits
    assert a.status == PASS and a.name == "Synthetic Links"
    assert 15 < a.info["distance_km"] < 40
    md = survey_markdown(result)
    assert "Buildable now (1)" in md and "Synthetic Links" in md
    assert "OpenStreetMap contributors" in md
