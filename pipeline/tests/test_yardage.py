import math

import pytest
from shapely.geometry import LineString

from golffly.course import associate
from golffly.geo import m_to_yd
from golffly.osm import HAZARD_KINDS, parse_elements
from golffly.teesets import build_tee_sets, rank_labels, tee_labels
from golffly.yardage import dedupe_hazards, distance_marks, green_points, hazards_along, tee_path, tee_yardage
from synthetic import (
    DOGLEG_ANGLE,
    FRAME,
    GREEN_R,
    hole_nodes,
    lane_x,
    make_course,
)


def setup(coloured=True):
    feats = parse_elements(make_course(coloured), FRAME)
    course = next(f for f in feats if f.kind == "course")
    cd = associate(course, [f for f in feats if f.kind in ("hole", "green", "tee", "pin")])
    hazards = dedupe_hazards([f for f in feats if f.kind in HAZARD_KINDS])
    return cd, hazards


def yards(m):
    return pytest.approx(m_to_yd(m), abs=0.15)


def tee_at(hole, y):
    return next(t for t in hole.tees if abs(t.anchor.y - y) < 1.0)


def test_green_front_middle_back_straight_hole():
    cd, _ = setup()
    h = cd.holes[1]
    gp = green_points(h.line, h.green.geom)
    x = lane_x(1)
    assert gp.approach_index == 1
    assert gp.front == pytest.approx((x, 360 - GREEN_R), abs=0.05)
    assert gp.middle == pytest.approx((x, 360), abs=0.05)
    assert gp.back == pytest.approx((x, 360 + GREEN_R), abs=0.05)
    assert gp.depth_m == pytest.approx(2 * GREEN_R, abs=0.05)
    assert gp.width_m == pytest.approx(2 * GREEN_R, abs=0.05)


def test_green_points_when_line_stops_short_of_the_green():
    green = LineString([(0, 300), (0, 301)]).buffer(15)  # spans y 285-316
    gp = green_points(LineString([(0, 0), (0, 200), (0, 270)]), green)  # line ends 15 m short
    assert gp.front[1] == pytest.approx(285.5, abs=0.5)
    assert gp.back[1] == pytest.approx(316, abs=0.5)


def test_per_tee_lengths_and_green_distances():
    cd, hazards = setup()
    h = cd.holes[1]
    gp = green_points(h.line, h.green.geom)
    for y, length in ((0, 360), (30, 330), (70, 290)):
        t = tee_at(h, y)
        ty = tee_yardage(t.id, tuple(t.anchor.coords[0]), h.line, gp, hazards, h.green.geom)
        assert ty.length_yd == yards(length)
        assert ty.middle_yd == yards(length)
        assert ty.front_yd == yards(length - GREEN_R)
        assert ty.back_yd == yards(length + GREEN_R)


def test_dogleg_length_and_marks():
    cd, _ = setup()
    h = cd.holes[4]  # par 5, 280 m then 190 m at 20 degrees
    gp = green_points(h.line, h.green.geom)
    back = tee_at(h, 0)
    path = tee_path(h.line, tuple(back.anchor.coords[0]), gp)
    assert len(path.coords) == 3
    assert m_to_yd(path.length) == yards(470)
    marks = {m["yd"]: m["point"] for m in distance_marks(path, gp.middle)}
    assert set(marks) == {100, 150, 200}
    for yd, (px, py) in marks.items():
        assert math.dist((px, py), gp.middle) == pytest.approx(yd * 0.9144, abs=0.01)
    # all three marks sit on the second (bent) segment, which is 190 m long
    end = hole_nodes(4)[-1]
    d200 = 200 * 0.9144
    assert marks[200] == pytest.approx(
        (end[0] - d200 * math.sin(DOGLEG_ANGLE), end[1] - d200 * math.cos(DOGLEG_ANGLE)), abs=0.05
    )


def test_marks_skip_distances_longer_than_the_hole():
    path = LineString([(0, 0), (0, 150)])
    assert [m["yd"] for m in distance_marks(path, (0, 150))] == [100, 150]


def test_forward_tee_skips_bend_behind_it():
    line = LineString([(0, 0), (0, 50), (0, 300)])
    gp = green_points(line, LineString([(0, 300), (0, 301)]).buffer(10))
    path = tee_path(line, (0, 80), gp)
    assert list(path.coords)[0] == (0, 80)
    assert len(path.coords) == 2


def test_fairway_and_greenside_bunkers():
    cd, hazards = setup()
    h = cd.holes[1]
    gp = green_points(h.line, h.green.geom)
    back = tee_at(h, 0)
    found = hazards_along(tee_path(h.line, tuple(back.anchor.coords[0]), gp), hazards, h.green.geom)
    fairway = next(z for z in found if not z["greenside"])
    assert fairway["kind"] == "bunker"
    assert fairway["reach_yd"] == yards(220)
    assert fairway["carry_yd"] == yards(240)
    assert fairway["side"] == "right"
    assert fairway["offset_yd"] == yards(10)
    greenside = next(z for z in found if z["greenside"])
    assert greenside["side"] == "left"
    assert greenside["reach_yd"] == yards(360 - 6)
    # nothing from the neighbouring lanes, 140 m away
    assert len(found) == 2


def test_water_crossing_and_duplicate_water_removed():
    cd, hazards = setup()
    water = [z for z in hazards if z.kind == "water"]
    assert len(water) == 1 and water[0].tags.get("golf") == "water_hazard"
    h = cd.holes[3]
    gp = green_points(h.line, h.green.geom)
    for y, reach, carry in ((0, 60, 90), (35, 25, 55)):
        t = tee_at(h, y)
        ty = tee_yardage(t.id, tuple(t.anchor.coords[0]), h.line, gp, hazards, h.green.geom)
        pond = next(z for z in ty.hazards if z["kind"] == "water")
        assert pond["side"] == "crosses"
        assert pond["reach_yd"] == yards(reach)
        assert pond["carry_yd"] == yards(carry)


def test_elevation_change_in_feet():
    cd, hazards = setup()
    h = cd.holes[1]
    gp = green_points(h.line, h.green.geom)
    t = tee_at(h, 0)
    ty = tee_yardage(t.id, tuple(t.anchor.coords[0]), h.line, gp, hazards, h.green.geom, lambda x, y: 0.02 * y)
    assert ty.elev_change_ft == pytest.approx(0.02 * 360 / 0.3048, abs=0.1)


# --- tee sets ------------------------------------------------------------------


@pytest.mark.parametrize(
    "tags,labels",
    [
        ({"tee": "white;gold"}, ["White", "Gold"]),
        ({"golf:tee": "blue"}, ["Blue"]),
        ({"name": "Hole 3 Blue Tees"}, ["Blue"]),
        ({"tee": "yes"}, []),
        ({"name": "7"}, []),
        ({}, []),
    ],
)
def test_tee_labels(tags, labels):
    assert tee_labels(tags) == labels


def test_rank_labels():
    assert rank_labels(1) == ["All"]
    assert rank_labels(3) == ["Back", "Middle", "Forward"]
    assert rank_labels(5) == ["Back", "Middle 1", "Middle 2", "Middle 3", "Forward"]


def _lengths(cd, hazards):
    out = {}
    for h in cd.holes.values():
        gp = green_points(h.line, h.green.geom)
        for t in h.tees:
            out[t.id] = tee_path(h.line, tuple(t.anchor.coords[0]), gp).length
    return out


@pytest.mark.parametrize("coloured", [True, False])
def test_tee_sets(coloured):
    cd, hazards = setup(coloured)
    sets = build_tee_sets({n: h.tees for n, h in cd.holes.items()}, _lengths(cd, hazards))
    labels = [s.label for s in sets]
    assert labels == (["Blue", "White", "Red"] if coloured else ["Back", "Middle", "Forward"])
    assert {s.source for s in sets} == {"osm" if coloured else "length"}
    # 4 par 3s, 10 par 4s and 4 par 5s
    assert sets[0].total_yd == round(m_to_yd(4 * 150 + 10 * 360 + 4 * 470))
    assert sets[1].total_yd == round(m_to_yd(4 * 135 + 10 * 330 + 4 * 440))
    assert sets[2].total_yd == round(m_to_yd(4 * 115 + 10 * 290 + 4 * 400))
    assert all(len(s.tees) == 18 and not s.fallback_holes for s in sets)


def test_tee_sets_fallback_when_a_hole_has_fewer_boxes():
    cd, hazards = setup(coloured=False)
    lengths = _lengths(cd, hazards)
    cd.holes[5].tees = sorted(cd.holes[5].tees, key=lambda t: -lengths[t.id])[:2]
    sets = build_tee_sets({n: h.tees for n, h in cd.holes.items()}, lengths)
    assert [s.label for s in sets] == ["Back", "Middle", "Forward"]
    assert all(5 in s.fallback_holes for s in sets)
