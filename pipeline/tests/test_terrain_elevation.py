import math

import numpy as np
import pytest
from shapely.geometry import LineString, Point

from golffly.elevation import (
    SOURCES,
    ElevationError,
    Raster,
    ResolvedSource,
    _year_of,
    choose_source,
    fetch_raster,
    lidar_metadata,
    read_tiff,
)
from golffly.terrain import (
    decode_heights,
    encode_heights,
    fill_gaps,
    gaussian_smooth,
    grid_utm_bounds,
    oriented_grid,
    sample_grid,
)
from synthetic import FRAME, FakeImageServer, terrain_local, terrain_utm, tiff_bytes

EPSG = FRAME.utm_epsg
COURSE_BOX = FRAME.bounds_to_utm((-300.0, -200.0, 300.0, 400.0))


def plane_raster(a=0.01, b=-0.02, c=200.0, px=1.0):
    e0, n0 = 400_000.0, 4_600_000.0
    h, w = 200, 300
    cols, rows = np.meshgrid(np.arange(w), np.arange(h))
    e = e0 + (cols + 0.5) * px
    n = n0 + h * px - (rows + 0.5) * px
    return Raster((a * (e - e0) + b * (n - n0) + c).astype(np.float32), e0, n0 + h * px, px, px, EPSG)


def test_bilinear_sampling_reproduces_a_plane():
    r = plane_raster()
    rng = np.random.default_rng(0)
    e = 400_000 + rng.uniform(2, 298, 500)
    n = 4_600_000 + rng.uniform(2, 198, 500)
    expected = 0.01 * (e - 400_000) - 0.02 * (n - 4_600_000) + 200
    assert np.allclose(r.sample(e, n), expected, atol=1e-3)
    assert np.isnan(r.sample([399_000.0], [4_600_050.0])[0])


def test_read_tiff_masks_nodata_and_keeps_georeferencing():
    data = np.full((10, 20), 210.0, dtype=np.float32)
    data[0, 0] = -9999.0
    data[1, 1] = 0.0  # zero fill outside a service's coverage
    bounds = (400_000.0, 4_600_000.0, 400_020.0, 4_600_010.0)
    r = read_tiff(tiff_bytes(data, bounds, EPSG), bounds, (20, 10), EPSG)
    assert (r.x0, r.y0, r.px, r.py) == pytest.approx((400_000.0, 4_600_010.0, 1.0, 1.0))
    assert np.isnan(r.data[0, 0]) and np.isnan(r.data[1, 1])
    assert r.coverage == pytest.approx(198 / 200)


def test_choose_source_falls_through_to_first_covering_service():
    server = FakeImageServer({"IL_Cook": False, "IL_DuPage": True, "3DEPElevation": True})
    src = choose_source(server, COURSE_BOX, EPSG)
    assert src.source.key == "isgs-dupage-2022"
    assert src.scale == 1.0 and src.coverage == 1.0
    assert "isgs-cook-2022: 0.0% coverage" in src.metadata["selection"]


def test_choose_source_detects_feet():
    server = FakeImageServer({"IL_Cook": True}, feet=True)
    src = choose_source(server, COURSE_BOX, EPSG)
    assert src.source.key == "isgs-cook-2022" and src.units == "ft"
    raster = fetch_raster(server, src, COURSE_BOX, 2.0, EPSG)
    e = np.array([COURSE_BOX[0] + 50.0])
    n = np.array([COURSE_BOX[1] + 50.0])
    assert raster.sample(e, n)[0] == pytest.approx(terrain_utm(e, n)[0], abs=0.01)


def test_choose_source_fails_when_nothing_covers():
    server = FakeImageServer({"IL_Cook": False, "IL_DuPage": False, "3DEPElevation": False})
    with pytest.raises(ElevationError, match="no elevation source"):
        choose_source(server, COURSE_BOX, EPSG)


def test_fetch_raster_tiles_large_requests():
    server = FakeImageServer({"3DEPElevation": True}, max_px=256)
    src = ResolvedSource(SOURCES[-1], 1.0, 1.0, max_px=256)
    raster = fetch_raster(server, src, COURSE_BOX, 1.0, EPSG)
    exports = [c for c in server.calls if c[0].endswith("/exportImage")]
    assert len(exports) == math.ceil(raster.data.shape[0] / 256) * math.ceil(raster.data.shape[1] / 256) > 4
    rng = np.random.default_rng(1)
    e = rng.uniform(COURSE_BOX[0] + 5, COURSE_BOX[2] - 5, 300)
    n = rng.uniform(COURSE_BOX[1] + 5, COURSE_BOX[3] - 5, 300)
    assert np.allclose(raster.sample(e, n), terrain_utm(e, n), atol=0.01)


def test_lidar_metadata_picks_newest_visible_item():
    server = FakeImageServer()
    src = ResolvedSource(SOURCES[-1], 1.0, 1.0)
    meta = lidar_metadata(server, src, 400_000.0, 4_600_000.0, EPSG)
    assert meta["year"] == 2021 and meta["project"] == "IL_Synthetic_2021"


def test_lidar_metadata_keeps_known_year():
    src = ResolvedSource(SOURCES[0], 1.0, 1.0)
    assert lidar_metadata(FakeImageServer(), src, 400_000.0, 4_600_000.0, EPSG)["year"] == 2022


@pytest.mark.parametrize(
    "value,year", [(1622505600000, 2021), ("2017-05-01", 2017), ("IL_Cook_2022", 2022), (2016, 2016), ("n/a", None)]
)
def test_year_of(value, year):
    assert _year_of(value) == year


# --- grids -------------------------------------------------------------------------


def test_oriented_grid_covers_geometry_with_padding():
    line = LineString([(0, 0), (100, 100), (150, 220)])
    rotation = math.atan2(220, 150)
    spec = oriented_grid(line, rotation, 1.0, 20.0)
    x, y = spec.centers()
    assert x.shape == (spec.rows, spec.cols)
    from shapely.geometry import Polygon

    footprint = Polygon([(x[0, 0], y[0, 0]), (x[0, -1], y[0, -1]), (x[-1, -1], y[-1, -1]), (x[-1, 0], y[-1, 0])])
    assert footprint.buffer(1.0).contains(line.buffer(19.0))
    # u axis really points along the rotation
    du = (x[0, 1] - x[0, 0], y[0, 1] - y[0, 0])
    assert math.atan2(du[1], du[0]) == pytest.approx(rotation)


def test_sample_grid_matches_terrain():
    server = FakeImageServer({"3DEPElevation": True})
    src = ResolvedSource(SOURCES[-1], 1.0, 1.0)
    spec = oriented_grid(Point(50, 120).buffer(20), 0.7, 0.25, 10.0)
    raster = fetch_raster(server, src, grid_utm_bounds(spec, FRAME, 2.0), 0.25, EPSG)
    values = sample_grid(spec, raster, FRAME)
    x, y = spec.centers()
    assert np.isfinite(values).all()
    assert np.allclose(values, terrain_local(x, y), atol=0.005)


def test_encode_decode_round_trip():
    rng = np.random.default_rng(2)
    v = (200 + rng.normal(0, 2, (40, 60))).astype(np.float32)
    v[3, 4] = np.nan
    v[10:12, :] = np.nan
    payload, header = encode_heights(v, 0.001)
    out = decode_heights(payload, header, 40, 60)
    assert np.array_equal(np.isnan(out), np.isnan(v))
    assert np.nanmax(np.abs(out - v)) <= 0.0005 + 2e-5  # half a step, plus float32 input precision
    assert header["encoding"] == "u16-delta-shuffle-gzip"


def test_encode_widens_step_for_tall_ranges():
    v = np.linspace(0, 120, 100, dtype=np.float32).reshape(10, 10)
    payload, header = encode_heights(v, 0.001)
    assert header["step_m"] >= 120 / 65000
    assert np.nanmax(np.abs(decode_heights(payload, header, 10, 10) - v)) <= header["step_m"]


def test_gaussian_smooth_keeps_planes_and_cuts_noise():
    yy, xx = np.mgrid[0:80, 0:80]
    plane = (0.01 * xx + 0.02 * yy).astype(np.float32)
    sm = gaussian_smooth(plane, 2.0)
    assert np.allclose(sm[10:-10, 10:-10], plane[10:-10, 10:-10], atol=1e-4)
    noisy = plane + np.random.default_rng(3).normal(0, 0.05, plane.shape).astype(np.float32)
    assert np.std((gaussian_smooth(noisy, 2.0) - plane)[10:-10, 10:-10]) < 0.015
    noisy[5, 5] = np.nan
    assert np.isnan(gaussian_smooth(noisy, 2.0)[5, 5])


def test_fill_gaps():
    yy, xx = np.mgrid[0:30, 0:30]
    v = (0.1 * xx).astype(np.float32)
    v[10:14, 10:14] = np.nan
    out = fill_gaps(v)
    assert np.isfinite(out).all()
    assert np.allclose(out[10:14, 10:14], 0.1 * xx[10:14, 10:14], atol=0.15)
