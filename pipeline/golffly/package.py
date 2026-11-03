"""Course package layout and serialisation.

A package is a folder::

    <slug>/course.json          course, holes, features, yardages, tee sets
    <slug>/holes/NN-terrain.bin  1 m hole corridor heights
    <slug>/holes/NN-green.bin    0.25 m smoothed green heights

Geometry in course.json is in the course's local frame (metres, x east,
y north); ``frame.proj4`` maps it to and from WGS84. Distances in
``yardages`` are yards, elevation changes are feet, heights are metres.
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import mapping
from shapely.geometry.base import BaseGeometry

SCHEMA = "golf-fly/course@1"
SIZE_BUDGET_BYTES = 5 * 1024 * 1024

# Tags worth keeping per feature kind (everything else is dropped to save space).
KEEP_TAGS = {
    "hole": ("ref", "par", "handicap", "name"),
    "tee": ("ref", "tee", "golf:tee", "tee:colour", "colour", "color", "name"),
    "green": ("ref", "name"),
    "water": ("name",),
    "stream": ("name", "waterway"),
    "trees": ("leaf_type",),
    "tree": ("leaf_type", "genus", "species"),
    "course": ("name", "website", "operator"),
}


def slugify(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "course"


def round_xy(p, nd: int = 2) -> list[float]:
    return [round(float(p[0]), nd), round(float(p[1]), nd)]


def geom_json(geom: BaseGeometry, nd: int = 1) -> dict:
    return mapping(shapely.transform(geom, lambda c: np.round(c, nd)))


def feature_json(f) -> dict:
    keep = KEEP_TAGS.get(f.kind, ("name",))
    tags = {k: f.tags[k] for k in keep if k in f.tags}
    out = {"id": f.id, "kind": f.kind, "geometry": geom_json(f.geom)}
    if tags:
        out["tags"] = tags
    return out


def write_package(out_dir: Path, payload: dict, blobs: dict[str, bytes]) -> int:
    """Write course.json and binary grids; returns total bytes."""
    out_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for rel, data in blobs.items():
        path = out_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        total += len(data)
    text = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    (out_dir / "course.json").write_text(text)
    return total + len(text.encode())
