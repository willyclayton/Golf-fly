"""A synthetic 18-hole course in Overpass JSON, plus a fake elevation image server.

Every hole runs north from y = 0 in its own 140 m lane, so expected yardages
are easy to state exactly:

* par 3: 150 m, two nodes;
* par 4: 360 m, three collinear nodes;
* par 5: 280 m north, then 190 m at 20 degrees east of north (a dogleg right).

Greens are 14 m circles centred on the hole line's end. Each hole has three
tee boxes (back, middle, forward) along its first segment. Par 4s and 5s have
a fairway bunker 20 m right of the line at 230 m and every hole has a
greenside bunker on the left. Hole 3 has a pond across the line from 60-90 m,
drawn twice (golf=water_hazard over natural=water).
"""

from __future__ import annotations

import io
import math
from copy import deepcopy

import numpy as np
import rasterio
from rasterio.transform import from_bounds

from golffly.geo import LocalFrame

FRAME = LocalFrame(41.70, -87.90)
PARS = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5]
LENGTH_M = {3: 150.0, 4: 360.0, 5: 470.0}
LANE_M = 140.0
GREEN_R = 14.0
TEE_STEPS = {3: (0.0, 15.0, 35.0), 4: (0.0, 30.0, 70.0), 5: (0.0, 30.0, 70.0)}
COLOURS = ("blue", "white", "red")
DOGLEG_FIRST_M = 280.0
DOGLEG_SECOND_M = 190.0
DOGLEG_ANGLE = math.radians(20.0)
COURSE_NAME = "Synthetic Links"
COURSE_ID = 900001


def lane_x(n: int) -> float:
    return (n - 1) * LANE_M - 8.5 * LANE_M


def hole_nodes(n: int) -> list[tuple[float, float]]:
    par = PARS[n - 1]
    x = lane_x(n)
    if par == 3:
        return [(x, 0.0), (x, 150.0)]
    if par == 4:
        return [(x, 0.0), (x, 230.0), (x, 360.0)]
    bx, by = x, DOGLEG_FIRST_M
    return [(x, 0.0), (bx, by), (bx + DOGLEG_SECOND_M * math.sin(DOGLEG_ANGLE), by + DOGLEG_SECOND_M * math.cos(DOGLEG_ANGLE))]


def circle(cx: float, cy: float, r: float, n: int = 72) -> list[tuple[float, float]]:
    pts = [(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
    return pts + [pts[0]]


def rect(cx: float, cy: float, w: float, h: float) -> list[tuple[float, float]]:
    pts = [(cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2), (cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2)]
    return pts + [pts[0]]


class ElementFactory:
    def __init__(self, frame: LocalFrame = FRAME):
        self.frame = frame
        self.next_node = 1
        self.next_way = 1000
        self.elements: list[dict] = []

    def _geometry(self, pts):
        xs = np.array([p[0] for p in pts])
        ys = np.array([p[1] for p in pts])
        lon, lat = self.frame.to_lonlat(xs, ys)
        return [{"lat": float(a), "lon": float(o)} for a, o in zip(lat, lon)]

    def way(self, pts, tags, closed=False, way_id=None) -> dict:
        geom = self._geometry(pts)
        nodes = list(range(self.next_node, self.next_node + len(pts)))
        self.next_node += len(pts)
        if closed:
            nodes[-1] = nodes[0]
        if way_id is None:
            way_id = self.next_way
            self.next_way += 1
        lats = [g["lat"] for g in geom]
        lons = [g["lon"] for g in geom]
        el = {
            "type": "way",
            "id": way_id,
            "bounds": {"minlat": min(lats), "minlon": min(lons), "maxlat": max(lats), "maxlon": max(lons)},
            "nodes": nodes,
            "geometry": geom,
            "tags": dict(tags),
        }
        self.elements.append(el)
        return el

    def node(self, pt, tags) -> dict:
        lon, lat = self.frame.to_lonlat(pt[0], pt[1])
        el = {"type": "node", "id": self.next_node, "lat": float(lat), "lon": float(lon), "tags": dict(tags)}
        self.next_node += 1
        self.elements.append(el)
        return el


def make_course(coloured_tees: bool = True) -> list[dict]:
    f = ElementFactory()
    f.way(rect(80.0, 250.0, 2700.0, 700.0), {"leisure": "golf_course", "name": COURSE_NAME}, closed=True, way_id=COURSE_ID)
    for n in range(1, 19):
        par = PARS[n - 1]
        nodes = hole_nodes(n)
        f.way(nodes, {"golf": "hole", "ref": str(n), "par": str(par), "handicap": str((n * 7) % 18 + 1)})
        gx, gy = nodes[-1]
        f.way(circle(gx, gy, GREEN_R), {"golf": "green"}, closed=True)
        f.node((gx, gy), {"golf": "pin"})
        x0 = nodes[0][0]
        for k, step in enumerate(TEE_STEPS[par]):
            tags = {"golf": "tee"}
            if coloured_tees:
                tags["tee"] = COLOURS[k]
            f.way(rect(x0, step, 10.0, 6.0), tags, closed=True)
        if par in (4, 5):
            f.way(circle(x0 + 20.0, 230.0, 10.0), {"golf": "bunker"}, closed=True)
        f.way(circle(gx - 22.0, gy, 6.0), {"golf": "bunker"}, closed=True)
        f.way(rect(x0 - 25.0, 200.0, 8.0, 300.0), {"golf": "rough"}, closed=True)
        f.way(rect(x0, 200.0, 35.0, 280.0), {"golf": "fairway"}, closed=True)
    x3 = lane_x(3)
    f.way(rect(x3, 75.0, 60.0, 30.0), {"golf": "water_hazard"}, closed=True)
    f.way(rect(x3, 75.0, 62.0, 31.0), {"natural": "water"}, closed=True)
    f.way(rect(lane_x(1) + LANE_M / 2, 250.0, 40.0, 400.0), {"natural": "wood"}, closed=True)
    f.node((lane_x(2) + 50.0, 100.0), {"natural": "tree"})
    f.way([(lane_x(1) - 40.0, -20.0), (lane_x(18) + 40.0, -20.0)], {"highway": "path"})
    return f.elements


def course_element(elements: list[dict]) -> dict:
    return next(e for e in elements if e.get("tags", {}).get("leisure") == "golf_course")


def without(elements: list[dict], pred) -> list[dict]:
    return [deepcopy(e) for e in elements if not pred(e)]


def hole_ref(e: dict) -> int | None:
    t = e.get("tags", {})
    return int(t["ref"]) if t.get("golf") == "hole" else None


# --- terrain ---------------------------------------------------------------


def terrain_local(x, y):
    """Ground height (m) in the synthetic course's local frame: rises 2% to the north."""
    return 200.0 + 0.02 * np.asarray(y) + 1.5 * np.sin(np.asarray(x) / 150.0)


def terrain_utm(e, n, frame: LocalFrame = FRAME):
    x, y = frame.from_utm(np.asarray(e, dtype=float), np.asarray(n, dtype=float))
    return terrain_local(x, y)


def tiff_bytes(data: np.ndarray, bounds, epsg: int, nodata: float = -9999.0) -> bytes:
    h, w = data.shape
    buf = io.BytesIO()
    with rasterio.io.MemoryFile() as mf:
        with mf.open(
            driver="GTiff",
            width=w,
            height=h,
            count=1,
            dtype="float32",
            crs=f"EPSG:{epsg}",
            transform=from_bounds(*bounds, w, h),
            nodata=nodata,
        ) as ds:
            ds.write(data.astype(np.float32), 1)
        buf.write(mf.read())
    return buf.getvalue()


class FakeImageServer:
    """Stands in for Http against ArcGIS image services. ``covers`` maps a URL
    fragment to whether that service has data here."""

    def __init__(self, covers: dict[str, bool] | None = None, feet: bool = False, max_px: int = 4000):
        self.covers = covers or {"IL_Cook": False, "IL_DuPage": False, "3DEPElevation": True}
        self.feet = feet
        self.max_px = max_px
        self.calls: list[tuple[str, dict]] = []
        self.requests_made = 0
        self.cache_hits = 0

    def _covered(self, url: str) -> bool:
        return next((v for k, v in self.covers.items() if k in url), False)

    def fetch(self, method, url, *, params=None, data=None, validate=None, cache=True, timeout_s=None):
        self.calls.append((url, dict(params or {})))
        assert url.endswith("/exportImage"), url
        xmin, ymin, xmax, ymax = (float(v) for v in params["bbox"].split(","))
        w, h = (int(v) for v in params["size"].split(","))
        assert w <= self.max_px and h <= self.max_px, "request larger than the server allows"
        epsg = int(params["imageSR"])
        px, py = (xmax - xmin) / w, (ymax - ymin) / h
        cols, rows = np.meshgrid(np.arange(w), np.arange(h))
        e = xmin + (cols + 0.5) * px
        n = ymax - (rows + 0.5) * py
        if self._covered(url):
            z = terrain_utm(e, n)
            if self.feet:
                z = z / 0.3048
        else:
            z = np.full(e.shape, -9999.0)
        body = tiff_bytes(z, (xmin, ymin, xmax, ymax), epsg)
        if validate:
            validate(body, "image/tiff")
        return body, "image/tiff"

    def get_json(self, url, params=None, **kw):
        self.calls.append((url, dict(params or {})))
        if url.endswith("/identify"):
            return {
                "catalogItems": {
                    "features": [
                        {"attributes": {"Name": "IL_Synthetic_2017", "AcquisitionDate": 1496275200000}},
                        {"attributes": {"Name": "IL_Synthetic_2021", "AcquisitionDate": 1622505600000}},
                    ]
                },
                "catalogItemVisibilities": [1, 1],
            }
        return {"maxImageWidth": self.max_px, "maxImageHeight": self.max_px}


def overpass_stub(elements: list[dict]):
    """A run_query replacement that answers course-by-id and feature queries from elements."""
    from golffly.overpass import OverpassResult

    def run(http, query, endpoints=None):
        if f"way({COURSE_ID})" in query:
            return OverpassResult([course_element(elements)], "2026-11-01T00:00:00Z", "stub")
        return OverpassResult(deepcopy(elements), "2026-11-01T00:00:00Z", "stub")

    return run
