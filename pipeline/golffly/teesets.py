"""Group tee boxes into course-wide tee sets.

When most holes carry tee colours or names in OSM, those become the sets
(a box tagged "white;gold" serves both). Otherwise tees are ranked by hole
length and labelled Back, Middle, Forward (spec: Course data pipeline). A hole
with fewer boxes than the set count lends its nearest-ranked box and is listed
in ``fallback_holes``.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field

from .osm import Feature

LABEL_KEYS = ("tee", "golf:tee", "tee:colour", "tee:color", "colour", "color", "name")
_NOT_LABELS = {"yes", "no", "tee", "tees", "box", "unknown"}
MIN_LABELLED_HOLES = 9  # colours must cover at least half the course to be trusted
MIN_SET_HOLES = 6  # a colour seen on fewer holes is a stray tag, not a set


@dataclass
class TeeSet:
    key: str
    label: str
    source: str  # "osm" or "length"
    tees: dict[int, str]  # hole number -> tee feature id
    fallback_holes: list[int] = field(default_factory=list)
    total_yd: float = 0.0


def tee_labels(tags: dict[str, str]) -> list[str]:
    for key in LABEL_KEYS:
        value = tags.get(key)
        if not value:
            continue
        if key == "name":
            value = re.sub(r"\b(tees?|box(es)?|hole|no\.?)\b|#?\d+", " ", value, flags=re.I)
        parts = [p.strip(" -_") for p in re.split(r"[;/,&]|\band\b", value)]
        labels = [p.title() for p in parts if p and p.lower() not in _NOT_LABELS and not p.isdigit()]
        if labels:
            return labels
    return []


def _slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "tees"


def rank_labels(k: int) -> list[str]:
    if k <= 1:
        return ["All"]
    if k == 2:
        return ["Back", "Forward"]
    if k == 3:
        return ["Back", "Middle", "Forward"]
    return ["Back", *[f"Middle {i}" for i in range(1, k - 1)], "Forward"]


def build_tee_sets(tees_by_hole: dict[int, list[Feature]], length_m: dict[str, float]) -> list[TeeSet]:
    """tees_by_hole: hole -> its tee boxes; length_m: tee id -> hole length from that tee."""
    ranked = {n: sorted(ts, key=lambda t: -length_m[t.id]) for n, ts in tees_by_hole.items() if ts}
    if not ranked:
        return []
    labels = {t.id: tee_labels(t.tags) for ts in ranked.values() for t in ts}
    labelled = sum(1 for ts in ranked.values() if all(labels[t.id] for t in ts))

    sets: list[TeeSet] = []
    if labelled >= min(MIN_LABELLED_HOLES, len(ranked)):
        seen = Counter(lab for ts in ranked.values() for lab in {lab for t in ts for lab in labels[t.id]})
        for name, count in seen.items():
            if count < min(MIN_SET_HOLES, len(ranked)):
                continue
            ts_ = TeeSet(_slug(name), name, "osm", {})
            rel_ranks = []
            for n, ts in ranked.items():
                for i, t in enumerate(ts):
                    if name in labels[t.id]:
                        ts_.tees[n] = t.id
                        rel_ranks.append(i / (len(ts) - 1) if len(ts) > 1 else 0.5)
                        break
            typical = sorted(rel_ranks)[len(rel_ranks) // 2]
            for n, ts in ranked.items():
                if n not in ts_.tees:
                    i = round(typical * (len(ts) - 1))
                    ts_.tees[n] = ts[i].id
                    ts_.fallback_holes.append(n)
            sets.append(ts_)
    if not sets:
        counts = Counter(len(ts) for ts in ranked.values())
        k = max(counts.items(), key=lambda kv: (kv[1], kv[0]))[0]
        for j, name in enumerate(rank_labels(k)):
            ts_ = TeeSet(_slug(name), name, "length", {})
            for n, ts in ranked.items():
                i = round(j * (len(ts) - 1) / (k - 1)) if k > 1 else 0
                ts_.tees[n] = ts[i].id
                if len(ts) != k:
                    ts_.fallback_holes.append(n)
            sets.append(ts_)

    for s in sets:
        s.total_yd = round(sum(length_m[t] for t in s.tees.values()) / 0.9144, 0)
        s.fallback_holes.sort()
    sets.sort(key=lambda s: -s.total_yd)
    return sets
