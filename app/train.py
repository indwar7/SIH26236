"""Train the learned ranker and export it to app/data/model.json.

    python -m app.train [--samples 6000]

There is no public dataset of expert packaging decisions, so the training set
is simulated: product and storage conditions are sampled around the commodity
database, and each case is labelled with the structure the physics-and-rules
engine ranks first (5 % of labels are swapped for the runner-up to mimic
disagreement between experts). The forest therefore learns a fast surrogate of
the engine. Replace `build_dataset` with real decisions when you have them;
nothing else changes.

Needs scikit-learn and numpy (requirements-dev.txt). The deployed app does not.
"""
from __future__ import annotations

import argparse
import json
import math
import random
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split

from . import db
from .engine import core, ml

MODEL_PATH = Path(__file__).parent / "data" / "model.json"
TRANSPORTS = list(core.TRANSPORT)


def _log_uniform(rng: random.Random, lo: float, hi: float) -> float:
    return math.exp(rng.uniform(math.log(lo), math.log(hi)))


def sample_input(rng: random.Random, commodities: list[dict]) -> dict:
    c = rng.choice(commodities)
    storage = c["storage"]
    if rng.random() < 0.1 and c["form"] != "produce":
        storage = rng.choice(["ambient", "chilled"])
    if storage == "ambient":
        temp, rh = rng.uniform(18, 38), rng.uniform(40, 90)
    elif storage == "chilled":
        base = c["temp"] if c["storage"] == "chilled" else 4
        temp, rh = base + rng.uniform(-2, 6), rng.uniform(75, 95)
    else:
        temp, rh = rng.uniform(-24, -12), rng.uniform(60, 80)

    wide = rng.random() < 0.12          # these cases go through the custom-commodity path
    spread = 0.35 if wide else 0.2
    inp = {
        "commodity_id": "custom" if wide else c["id"],
        "form": c["form"],
        "moisture": min(99.0, c["moisture"] * rng.uniform(1 - spread, 1 + spread)),
        "fat": min(100.0, c["fat"] * rng.uniform(1 - spread, 1 + spread)),
        "ph": c["ph"] + rng.uniform(-0.4, 0.4),
        "respiration": c["resp20"] * rng.uniform(0.7, 1.3),
        "shelf_life_days": max(1.0, c["shelf_life"] * _log_uniform(rng, 0.3, 1.6)),
        "storage_type": storage,
        "temp_c": temp,
        "rh": rh,
        "transport": rng.choice(TRANSPORTS),
        "pack_g": min(50000.0, max(20.0, c["pack_g"] * _log_uniform(rng, 0.4, 3.0))),
        "priority": "balanced",
    }
    return inp


def build_dataset(n: int, seed: int, data: dict) -> tuple[list[list[float]], list[str]]:
    rng = random.Random(seed)
    commodities = list(data["commodities"].values())
    xs, ys = [], []
    while len(xs) < n:
        inp = sample_input(rng, commodities)
        profile = core.build_profile(inp, data["commodities"])
        result = core.recommend(inp, data)
        cands = result["candidates"]
        if not cands:
            continue
        label = cands[0]["id"]
        if len(cands) > 1 and rng.random() < 0.05:
            label = cands[1]["id"]
        xs.append(ml.features(profile))
        ys.append(label)
    return xs, ys


def export(forest: RandomForestClassifier, meta: dict) -> dict:
    trees = []
    for est in forest.estimators_:
        t = est.tree_
        leaves = {}
        for node in range(t.node_count):
            if t.children_left[node] == -1:
                v = t.value[node][0]
                total = float(v.sum()) or 1.0
                leaves[str(node)] = [[int(i), round(float(x) / total, 3)]
                                     for i, x in enumerate(v) if x / total >= 0.0005]
        trees.append({
            "f": [int(f) if f >= 0 else -1 for f in t.feature],
            "t": [round(float(x), 4) for x in t.threshold],
            "l": [int(x) for x in t.children_left],
            "r": [int(x) for x in t.children_right],
            "v": leaves,
        })
    return {"classes": [str(c) for c in forest.classes_], "trees": trees, "meta": meta}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=6000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    data = db.load()
    xs, ys = build_dataset(args.samples, args.seed, data)
    x, y = np.array(xs), np.array(ys)

    counts = {c: int((y == c).sum()) for c in set(ys)}
    keep = np.array([counts[c] >= 2 for c in y])
    x, y = x[keep], y[keep]
    x_tr, x_te, y_tr, y_te = train_test_split(x, y, test_size=0.2, random_state=args.seed, stratify=y)

    forest = RandomForestClassifier(n_estimators=60, max_depth=14, min_samples_leaf=2,
                                    random_state=args.seed, n_jobs=-1)
    forest.fit(x_tr, y_tr)

    proba = forest.predict_proba(x_te)
    top1 = float((forest.classes_[proba.argmax(axis=1)] == y_te).mean())
    top3_idx = np.argsort(-proba, axis=1)[:, :3]
    top3 = float(np.mean([y_te[i] in forest.classes_[top3_idx[i]] for i in range(len(y_te))]))

    order = np.argsort(-forest.feature_importances_)[:8]
    importance = [{"feature": ml.FEATURE_NAMES[i], "importance": round(float(forest.feature_importances_[i]), 3)}
                  for i in order]

    forest.fit(x, y)   # final model uses every case
    meta = {
        "model": "Random forest, 60 trees",
        "trained_on": date.today().isoformat(),
        "samples": int(len(y)),
        "classes": int(len(forest.classes_)),
        "holdout_top1": round(top1, 3),
        "holdout_top3": round(top3, 3),
        "data": "Simulated cases labelled by the rules engine, 5 % label noise",
        "importance": importance,
    }
    blob = export(forest, meta)

    # the exported forest must reproduce scikit-learn's probabilities
    check = ml.ForestModel(blob)
    worst = 0.0
    for row in x_te[:200]:
        ours = check.predict_vector([float(v) for v in row])
        theirs = forest.predict_proba(row.reshape(1, -1))[0]
        worst = max(worst, float(np.max(np.abs(np.array(ours) - theirs))))
    meta["export_max_error"] = round(worst, 4)

    MODEL_PATH.write_text(json.dumps(blob, separators=(",", ":")))
    print(json.dumps(meta, indent=2))
    print(f"wrote {MODEL_PATH} ({MODEL_PATH.stat().st_size / 1024:.0f} kB)")


if __name__ == "__main__":
    main()
