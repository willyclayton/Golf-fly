"""Check built hole lengths against a published scorecard.

A scorecard file (``courses/scorecards/<slug>.yaml``) holds the course's
printed yardages::

    course: Example Golf Club
    source: https://example.com/scorecard   # where the numbers came from
    par: [4, 4, 3, ...]                      # optional, 18 values
    tees:
      Blue: [402, 388, 175, ...]             # 18 values per tee
      White: [380, 371, 160, ...]

Scorecard tees match tee sets by name, else by the closest total yardage.
"""

from __future__ import annotations

from pathlib import Path

import yaml


def load_scorecard(path: Path) -> dict:
    doc = yaml.safe_load(path.read_text()) or {}
    tees = doc.get("tees") or {}
    if not tees:
        raise ValueError(f"{path}: no tees")
    for name, yards in tees.items():
        if not isinstance(yards, list) or len(yards) != 18:
            raise ValueError(f"{path}: tee {name!r} needs 18 yardages")
    if "par" in doc and len(doc["par"]) != 18:
        raise ValueError(f"{path}: par needs 18 values")
    return doc


def compare(payload: dict, card: dict) -> dict:
    sets = payload["tee_sets"]
    holes = {h["number"]: h for h in payload["holes"]}
    result = {"tees": {}, "par_mismatches": []}
    for name, yards in card["tees"].items():
        match = next((s for s in sets if s["label"].lower() == str(name).lower()), None)
        how = "name"
        if match is None:
            match = min(sets, key=lambda s: abs(s["total_yd"] - sum(yards)))
            how = "closest total"
        diffs = []
        for n in range(1, 19):
            tee_id = match["tees"].get(str(n))
            built = next((t["length_yd"] for t in holes[n]["tees"] if t["id"] == tee_id), None)
            diffs.append(None if built is None else round(built - yards[n - 1], 1))
        known = [abs(d) for d in diffs if d is not None]
        result["tees"][str(name)] = {
            "set": match["label"],
            "matched_by": how,
            "card_total": sum(yards),
            "built_total": match["total_yd"],
            "diffs": diffs,
            "mean_abs": round(sum(known) / len(known), 1) if known else None,
            "max_abs": max(known) if known else None,
            "within_5": sum(1 for d in known if d <= 5),
            "within_10": sum(1 for d in known if d <= 10),
        }
    for n, par in enumerate(card.get("par") or [], start=1):
        if holes[n]["par"] != par:
            result["par_mismatches"].append({"hole": n, "card": par, "built": holes[n]["par"]})
    return result


def compare_markdown(card: dict, result: dict) -> str:
    lines = [
        "## Scorecard check",
        "",
        f"Scorecard: {card.get('source') or 'source not given'}",
        "",
        "| Scorecard tee | Tee set | Matched by | Card yd | Built yd | Mean abs diff | Max abs diff | Holes within 5 / 10 yd |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for name, r in result["tees"].items():
        lines.append(
            f"| {name} | {r['set']} | {r['matched_by']} | {r['card_total']} | {r['built_total']:.0f} | "
            f"{r['mean_abs']} | {r['max_abs']} | {r['within_5']} / {r['within_10']} of 18 |"
        )
    lines += ["", "Built minus scorecard, yards:", ""]
    lines += ["| Tee | " + " | ".join(str(n) for n in range(1, 19)) + " |", "|" + " --- |" * 19]
    for name, r in result["tees"].items():
        lines.append(f"| {name} | " + " | ".join("-" if d is None else f"{d:+.0f}" for d in r["diffs"]) + " |")
    if result["par_mismatches"]:
        lines += ["", "Par differs on: " + ", ".join(f"hole {m['hole']} (card {m['card']}, built {m['built']})" for m in result["par_mismatches"])]
    lines.append("")
    return "\n".join(lines)
