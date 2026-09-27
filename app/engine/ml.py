"""Learned ranker.

A random forest is trained offline (app/train.py, needs scikit-learn) and
exported to JSON. Inference here is plain Python so the deployed app carries
no numeric dependencies.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

from . import physics as ph

FORM_ORDER = ["produce", "solid", "fragile", "powder", "granular", "liquid", "paste"]
MODE_ORDER = ["air", "n2_flush", "map_gas", "vacuum", "emap", "ventilated",
              "hermetic", "aseptic", "retort", "hot_fill"]
STORAGE_ORDER = ["ambient", "chilled", "frozen"]

FEATURE_NAMES = (
    ["moisture", "fat", "ph", "aw", "log_respiration", "log_shelf_life", "temp", "rh",
     "transport_level", "log_pack_kg", "sens_o2", "sens_moisture", "sens_light", "sens_aroma",
     "has_o2_budget"]
    + [f"form_{f}" for f in FORM_ORDER]
    + [f"mode_{m}" for m in MODE_ORDER]
    + [f"storage_{s}" for s in STORAGE_ORDER]
)


def features(p: dict) -> list[float]:
    """Feature vector from an engine profile (see core.build_profile)."""
    resp_t = ph.respiration_at(p["resp20"], p.get("resp_q10", 2.3), p["temp"]) if p["is_produce"] else 0.0
    row = [
        p["moisture"], p["fat"], p["ph"], p["aw"],
        math.log1p(resp_t), math.log(max(p["shelf_life"], 1.0)),
        p["temp"], p["rh"], float(p["transport_level"]), math.log(max(p["pack_kg"], 0.01)),
        float(p["sens"]["o2"]), float(p["sens"]["moisture"]),
        float(p["sens"]["light"]), float(p["sens"]["aroma"]),
        1.0 if p.get("o2_budget") else 0.0,
    ]
    row += [1.0 if p["form"] == f else 0.0 for f in FORM_ORDER]
    row += [1.0 if p["mode"] == m else 0.0 for m in MODE_ORDER]
    row += [1.0 if p["storage"] == s else 0.0 for s in STORAGE_ORDER]
    return row


class ForestModel:
    """Random forest stored as flat arrays per tree."""

    def __init__(self, blob: dict):
        self.classes: list[str] = blob["classes"]
        self.trees: list[dict] = blob["trees"]
        self.meta: dict = blob["meta"]

    @classmethod
    def load(cls, path: Path) -> "ForestModel | None":
        try:
            with open(path, "r", encoding="utf-8") as fh:
                return cls(json.load(fh))
        except (OSError, ValueError, KeyError):
            return None

    def predict_vector(self, x: list[float]) -> list[float]:
        total = [0.0] * len(self.classes)
        for tree in self.trees:
            feat, thr = tree["f"], tree["t"]
            left, right, leaf = tree["l"], tree["r"], tree["v"]
            node = 0
            while feat[node] >= 0:
                node = left[node] if x[feat[node]] <= thr[node] else right[node]
            for cls_idx, prob in leaf[str(node)]:
                total[cls_idx] += prob
        n = float(len(self.trees))
        return [v / n for v in total]

    def predict(self, profile: dict) -> dict[str, float]:
        probs = self.predict_vector(features(profile))
        return dict(zip(self.classes, probs))

    def info(self) -> dict:
        return dict(self.meta)
