"""Recommendation engine.

Pipeline: build a product profile -> predict barrier requirements -> reject
incompatible structures -> size each remaining structure and predict its
shelf life -> score and rank.
"""
from __future__ import annotations

import copy
import math

from . import physics as ph

TRANSPORT = {
    "local": (1, "Local delivery"),
    "regional": (2, "Regional road"),
    "long_haul": (3, "Long-haul road"),
    "export": (4, "Export by sea or air"),
}

FORMS = {
    "produce": "Fresh produce",
    "solid": "Solid",
    "fragile": "Fragile or crisp",
    "powder": "Powder",
    "granular": "Grains or granules",
    "liquid": "Liquid",
    "paste": "Paste or sauce",
}

MODES = {
    "air": "Packed in air",
    "n2_flush": "Nitrogen flush",
    "map_gas": "Gas-flushed modified atmosphere",
    "vacuum": "Vacuum pack",
    "emap": "Passive modified atmosphere",
    "ventilated": "Ventilated pack",
    "hermetic": "Hermetic storage",
    "aseptic": "Aseptic fill",
    "retort": "Retort sterilisation",
    "hot_fill": "Hot fill",
}

RECYCLE = {
    "reusable": ("Reusable", 95),
    "recyclable": ("Recyclable", 85),
    "compostable": ("Compostable", 78),
    "limited": ("Limited recycling", 45),
    "not_recyclable": ("Not recyclable", 12),
}

PUNCTURE_LABEL = {1: "Low", 2: "Moderate", 3: "Good", 4: "High", 5: "Very high"}

WEIGHTS = {
    "balanced":       {"barrier": 35, "mech": 12, "compat": 15, "cost": 14, "sustain": 14, "ml": 10},
    "cost":           {"barrier": 30, "mech": 10, "compat": 12, "cost": 30, "sustain": 8,  "ml": 10},
    "sustainability": {"barrier": 30, "mech": 10, "compat": 12, "cost": 8,  "sustain": 30, "ml": 10},
    "shelf_life":     {"barrier": 45, "mech": 12, "compat": 18, "cost": 8,  "sustain": 7,  "ml": 10},
}

MAX_LIFE_DAYS = 1500.0
HOT_FILL_C = 85
ANAEROBIC_O2 = 0.015


# --------------------------------------------------------------------------
# Profile
# --------------------------------------------------------------------------

def nearest_commodity(inp: dict, commodities: dict) -> dict:
    """Closest known commodity to a custom product, by composition and form."""
    m = float(inp.get("moisture") or 0)
    fat = float(inp.get("fat") or 0)
    p_h = float(inp.get("ph") or 6.5)
    resp = float(inp.get("respiration") or 0)
    form = inp.get("form")
    storage = inp.get("storage_type")
    best, best_d = None, float("inf")
    for c in commodities.values():
        d = ((m - c["moisture"]) / 100) ** 2
        d += 1.5 * ((fat - c["fat"]) / 100) ** 2
        d += 0.5 * ((p_h - c["ph"]) / 7) ** 2
        d += 1.5 * ((math.log1p(resp) - math.log1p(c["resp20"])) / math.log1p(300)) ** 2
        if form and form != c["form"]:
            d += 2.0
        if storage and storage != c["storage"]:
            d += 0.15
        if d < best_d:
            best, best_d = c, d
    return best


def build_profile(inp: dict, commodities: dict) -> dict:
    cid = inp.get("commodity_id") or "custom"
    custom = cid == "custom" or cid not in commodities
    base = nearest_commodity(inp, commodities) if custom else commodities[cid]
    p = copy.deepcopy(base)

    def val(key, default):
        v = inp.get(key)
        return default if v is None else v

    if custom:
        p["id"] = "custom"
        p["name"] = (inp.get("custom_name") or "").strip() or "Custom commodity"
        p["template"] = base["name"]
        p["form"] = inp.get("form") or base["form"]
        p.pop("note", None)

    p["moisture"] = float(val("moisture", base["moisture"]))
    p["fat"] = float(val("fat", base["fat"]))
    p["ph"] = float(val("ph", base["ph"]))
    resp = val("respiration", None)
    p["resp20"] = float(base["resp20"] if resp is None or (p["form"] == "produce" and resp <= 0) else resp)
    p["shelf_life"] = float(val("shelf_life_days", base["shelf_life"]))
    p["storage"] = val("storage_type", base["storage"])
    p["temp"] = float(val("temp_c", base["temp"]))
    p["rh"] = float(val("rh", base["rh"]))
    p["transport"] = val("transport", "regional")
    p["transport_level"] = TRANSPORT[p["transport"]][0]
    p["pack_kg"] = float(val("pack_g", base["pack_g"])) / 1000.0
    p["priority"] = val("priority", "balanced")

    shift = ph.aw_from_moisture(p["moisture"]) - ph.aw_from_moisture(base["moisture"])
    p["aw"] = max(0.05, min(0.999, base["aw"] + shift))

    p["is_produce"] = p["form"] == "produce" and p["resp20"] > 0 and p["storage"] != "frozen"
    if p["form"] == "produce" and not p["is_produce"]:
        # frozen produce no longer respires: treat as a frozen solid packed in air
        p["mode"] = "air"
        p["moist_change"] = -1.5
        p["life"] = {"air": 300, "protected": 450, "ref_temp": -18, "q10": 2.5}

    if not p["is_produce"] and p["fat"] >= 15 and not p.get("o2_budget"):
        p["o2_budget"] = 3000
        p["sens"]["o2"] = max(p["sens"]["o2"], 2)

    p["area_m2"] = p["area_coef"] * p["pack_kg"] ** (2.0 / 3.0)
    p["regime"] = _regime(p)
    return p


def _regime(p: dict) -> str:
    if p["is_produce"]:
        return "Respiring fresh produce"
    if p["storage"] == "frozen":
        return "Frozen food"
    if p["form"] in ("liquid", "paste"):
        return "Acidic liquid or paste" if p["ph"] < 4.6 else "Low-acid liquid or paste"
    if p["aw"] < 0.6:
        return "Dry, fat-rich food" if p["fat"] >= 15 else "Dry food"
    if p["aw"] < 0.9:
        return "Intermediate-moisture food"
    return "Moist perishable food"


# --------------------------------------------------------------------------
# Requirements
# --------------------------------------------------------------------------

def _life_at_temp(p: dict, key: str) -> float:
    life = p["life"]
    days = life[key] * ph.q10_factor(life["q10"], life["ref_temp"], p["temp"])
    return min(days, MAX_LIFE_DAYS)


def _vapour_ratio(p: dict) -> tuple[float, str]:
    """Water-vapour driving force relative to the WVTR test, and its direction."""
    psat = ph.psat_kpa(p["temp"])
    rh = p["rh"] / 100.0
    aw = 1.0 if p["storage"] == "frozen" else p["aw"]
    if p["moist_change"] >= 0:
        dp, direction = psat * (rh - aw), "gain"
    else:
        dp, direction = psat * (aw - rh), "loss"
    return max(dp, 0.0) / ph.DP_WVTR_TEST, direction


def otr_class(v: float | None) -> str:
    if v is None:
        return "None needed"
    if v < 1:
        return "Very high"
    if v < 10:
        return "High"
    if v < 100:
        return "Medium"
    if v < 1000:
        return "Low"
    return "Minimal"


def wvtr_class(v: float | None) -> str:
    if v is None:
        return "None needed"
    if v < 0.5:
        return "Very high"
    if v < 2:
        return "High"
    if v < 6:
        return "Medium"
    if v < 20:
        return "Low"
    return "Minimal"


def compute_requirements(p: dict) -> dict:
    t_des = p["shelf_life"]
    w, area = p["pack_kg"], p["area_m2"]
    f_t = ph.gas_temp_factor(p["temp"])
    req: dict = {"area_m2": area, "gas_temp_factor": f_t, "drivers": []}

    level = p["transport_level"]
    puncture = 1 + (level >= 3) + (level >= 4) + (w > 2) + bool(p.get("sharp"))
    req["puncture_min"] = min(5, puncture)
    req["light_barrier_needed"] = p["sens"]["light"] >= 2
    req["grease_needed"] = p["fat"] >= 15 and not p["is_produce"]
    req["temp_service"] = p["temp"]

    if p["is_produce"]:
        _produce_requirements(p, req)
    else:
        ratio, direction = _vapour_ratio(p)
        if p["sens"]["moisture"] == 0:
            ratio = 0.0
        allow_g = abs(p["moist_change"]) / 100.0 * w * 1000.0
        req["moisture_direction"] = direction
        req["moisture_allow_g"] = allow_g
        req["vapour_ratio"] = ratio
        wvtr_max = allow_g / (area * t_des * ratio) if ratio > 1e-5 else None
        if wvtr_max is not None and wvtr_max > 3000:
            wvtr_max = None
        req["wvtr_max"] = wvtr_max

        life_air = _life_at_temp(p, "air")
        otr_max = None
        if p.get("o2_budget") and t_des > life_air:
            otr_max = p["o2_budget"] * w / (area * ph.O2_IN_AIR * t_des * f_t)
        req["otr_max"] = otr_max

        if wvtr_max is not None:
            verb = "gain" if direction == "gain" else "loss"
            req["drivers"].append(
                f"Moisture {verb}: the pack may {'take up' if verb == 'gain' else 'lose'} "
                f"{allow_g:.1f} g of water over {t_des:.0f} days."
            )
        if otr_max is not None:
            req["drivers"].append(
                "Oxidation: fat and flavour break down as oxygen permeates in."
            )
        if p["mode"] in ("vacuum", "map_gas", "retort", "aseptic", "hot_fill", "hermetic"):
            req["drivers"].append(f"Process: {MODES[p['mode']].lower()} decides which films qualify.")
        if p["sens"]["light"] >= 2:
            req["drivers"].append("Light: speeds up rancidity and fades colour.")
        if p["sens"]["aroma"] >= 3:
            req["drivers"].append("Aroma: volatile flavour escapes through polyolefin films.")

    req["otr_class"] = otr_class(req.get("otr_max"))
    req["wvtr_class"] = wvtr_class(req.get("wvtr_max"))
    req["map"] = _map_recommendation(p)
    req["secondary"] = _secondary_pack(p)
    return req


def _produce_requirements(p: dict, req: dict) -> None:
    w, area = p["pack_kg"], p["area_m2"]
    f_t = req["gas_temp_factor"]
    resp_t = ph.respiration_at(p["resp20"], p.get("resp_q10", 2.3), p["temp"])
    resp_ml = resp_t * ph.ML_CO2_PER_MG
    req["respiration_at_temp"] = resp_t
    req["respiration_ml"] = resp_ml

    psat = ph.psat_kpa(p["temp"])
    dp = psat * (1.0 - p["rh"] / 100.0)
    req["free_loss_pct_day"] = p.get("transp", 0.6) * dp
    req["vapour_ratio"] = dp / ph.DP_WVTR_TEST
    req["moisture_direction"] = "loss"
    req["moisture_allow_g"] = abs(p["moist_change"]) / 100.0 * w * 1000.0
    req["wvtr_max"] = None
    req["otr_max"] = None

    if p["mode"] == "ventilated":
        req["drivers"].append("Ventilation: this crop stores best in moving, dry air, not in a modified atmosphere.")
        return

    y_o2 = p["gas"]["o2"] / 100.0
    y_co2 = max(p["gas"]["co2"] / 100.0, 0.005)
    km = 0.03
    r_eq = resp_ml * (y_o2 * (km + ph.O2_IN_AIR)) / (ph.O2_IN_AIR * (km + y_o2))
    pack_perm_o2 = r_eq * w * 24.0 / (ph.O2_IN_AIR - y_o2)
    pack_perm_co2 = r_eq * w * 24.0 / (y_co2 - ph.CO2_IN_AIR)
    req["pack_perm_o2"] = pack_perm_o2
    req["otr_target_storage"] = pack_perm_o2 / area
    req["otr_target"] = pack_perm_o2 / area / f_t
    req["co2tr_target"] = pack_perm_co2 / area / f_t
    req["beta_target"] = pack_perm_co2 / pack_perm_o2
    req["drivers"].append(
        f"Respiration: {resp_t:.0f} mg CO2 per kg per hour at {p['temp']:.0f} °C. "
        "The film must let oxygen in as fast as the produce uses it."
    )
    req["drivers"].append("Water loss: the film must slow wilting without fogging.")


def _map_recommendation(p: dict) -> dict:
    mode = p["mode"]
    gas = p.get("gas", {})
    if p["is_produce"] and mode == "emap":
        o2, co2 = gas["o2"], gas["co2"]
        return {"suitable": True, "mode": mode, "label": MODES[mode],
                "gas": {"o2": o2, "co2": co2, "n2": 100 - o2 - co2},
                "note": "No gas is injected. The produce's own respiration and a film of the right "
                        "permeability settle at this atmosphere within one to two days."}
    if mode == "n2_flush":
        return {"suitable": True, "mode": mode, "label": MODES[mode],
                "gas": {"o2": gas.get("o2", 0), "co2": gas.get("co2", 0), "n2": gas.get("n2", 100)},
                "note": "Flush to under 2 % residual oxygen before sealing."}
    if mode == "map_gas":
        return {"suitable": True, "mode": mode, "label": MODES[mode],
                "gas": {"o2": gas["o2"], "co2": gas["co2"], "n2": gas["n2"]},
                "note": "Use a gas-to-product volume ratio of at least 2 : 1; carbon dioxide dissolves into the food."}
    if mode == "vacuum":
        alt = None
        if gas.get("co2"):
            alt = {"o2": gas["o2"], "co2": gas["co2"], "n2": gas["n2"]}
        return {"suitable": True, "mode": mode, "label": MODES[mode], "gas": alt,
                "note": "Vacuum is the first choice." + (" The gas mix shown is the alternative for sliced or soft packs."
                                                         if alt else " Modified atmosphere adds nothing over a good vacuum.")}
    if mode == "hermetic":
        return {"suitable": True, "mode": mode, "label": MODES[mode],
                "gas": {"o2": gas["o2"], "co2": gas["co2"], "n2": gas["n2"]},
                "note": "No gas is injected. Grain and insects use up the oxygen in an airtight bag within two to three weeks."}
    reasons = {
        "ventilated": "This crop needs moving air. A modified atmosphere causes rot or sprouting.",
        "retort": "The pack is sterilised after sealing, so the atmosphere does not matter.",
        "aseptic": "The product is sterile-filled with minimal headspace.",
        "hot_fill": "Hot filling drives the air out and pulls a vacuum as it cools.",
        "air": "Barrier and seal matter more than the gas inside for this product.",
    }
    return {"suitable": False, "mode": mode, "label": MODES.get(mode, mode), "gas": None,
            "note": reasons.get(mode, reasons["air"])}


def _secondary_pack(p: dict) -> str:
    level = p["transport_level"]
    if level >= 4:
        return "5-ply corrugated carton, palletised and stretch-wrapped."
    if level == 3:
        return "3-ply or 5-ply corrugated carton."
    if level == 2:
        return "3-ply corrugated carton or returnable crate."
    return "Returnable crate or tray."


# --------------------------------------------------------------------------
# Hard constraints
# --------------------------------------------------------------------------

def produce_only(s: dict) -> bool:
    return bool(s.get("ventilated") or s.get("perforation") or s.get("produce_only"))


def reject_reason(s: dict, p: dict) -> str | None:
    w, t = p["pack_kg"], p["temp"]
    if w > s["max_pack_kg"]:
        return f"Too light-duty for a {_kg(w)} pack (limit {_kg(s['max_pack_kg'])})."
    if w < s.get("min_pack_kg", 0):
        return f"Bulk format, not used below {_kg(s['min_pack_kg'])}."
    if t < s["temp_min"]:
        return f"Turns brittle below {s['temp_min']} °C."
    if t > s["temp_max"]:
        return f"Softens above {s['temp_max']} °C."
    if p["form"] in ("liquid", "paste") and not s["liquid_ok"]:
        return "Cannot hold liquids or pastes."
    if p["mode"] == "retort" and not s["retort_ok"]:
        return "Does not survive retort sterilisation at 121 °C."
    if p["mode"] == "aseptic" and not s["aseptic_ok"]:
        return "Cannot be sterilised for aseptic filling."
    if p["mode"] == "hot_fill" and s["temp_max"] < HOT_FILL_C:
        return f"Softens at the {HOT_FILL_C} °C filling temperature."
    only = s.get("only_modes")
    if only and p["mode"] not in only:
        return "Built for " + " or ".join(only) + " lines; over-specified here."
    if p["shelf_life"] > s.get("max_shelf_days", MAX_LIFE_DAYS):
        return f"Made for a shelf life under {s['max_shelf_days']} days."
    if p["storage"] == "frozen" and s["seal"]["rating"] < 4:
        return "Seals turn brittle and split in the freezer."
    liquid = p["form"] in ("liquid", "paste")
    if s.get("liquid_only") and not liquid:
        return "Made for liquid form-fill-seal lines."
    if liquid and len(s["layers"]) == 1 and not s.get("rigid") and p["shelf_life"] > 60:
        return "A single-web pouch flex-cracks and leaks over a long distribution life."
    if p["is_produce"]:
        if not s["breathable"]:
            return "Too airtight for respiring produce: the pack would turn anaerobic."
    else:
        if produce_only(s):
            return "Open or perforated pack: gives no barrier."
        if p["form"] == "solid" and p["moisture"] >= 50 and p["storage"] != "frozen" and not s["liquid_ok"]:
            return "Seals are not liquid-tight: wet foods weep through them."
        if s.get("rigid") and p["form"] not in ("liquid", "paste", "powder", "granular"):
            return "A rigid container does not suit this product form."
        if p["fat"] >= 20 and s["grease"] <= 2:
            return "Oil seeps into or through this material."
    if p["form"] == "powder" and s["seal"]["rating"] < 3:
        return "Seal is not tight enough for powder."
    if p.get("aggressive") and any(layer["m"] == "ALU" for layer in s["layers"]):
        return "Acid, salt and oil together attack the foil layer."
    return None


def _kg(w: float) -> str:
    return f"{w * 1000:.0f} g" if w < 1 else f"{w:g} kg"


# --------------------------------------------------------------------------
# Sizing and shelf life
# --------------------------------------------------------------------------

def _thickness_options(s: dict, p: dict) -> tuple[int | None, list[float]]:
    idx = next((i for i, layer in enumerate(s["layers"]) if "adjust" in layer), None)
    if idx is None:
        return None, []
    lo, hi = s["layers"][idx]["adjust"]
    span = hi - lo
    step = 2 if span <= 12 else 5 if span <= 150 else 50
    duty = 0.3 if p["is_produce"] else 0.8
    frac = min(1.0, duty * math.sqrt(p["pack_kg"] / s["max_pack_kg"]) + (0.1 if p["transport_level"] >= 3 else 0))
    start = lo + math.ceil(frac * span / step - 1e-9) * step
    start = min(start, hi)
    opts = []
    t = start
    while t <= hi + 1e-9:
        opts.append(float(t))
        t += step
    return idx, opts


def _with_thickness(s: dict, idx: int | None, um: float | None) -> list[dict]:
    layers = [dict(layer) for layer in s["layers"]]
    if idx is not None and um is not None:
        layers[idx]["um"] = um
    return layers


def _mode_supported(s: dict, mode: str) -> bool:
    if mode == "vacuum":
        return s["vacuum_ok"]
    if mode in ("n2_flush", "map_gas"):
        return s["gas_flush_ok"]
    if mode == "hermetic":
        return bool(s.get("hermetic"))
    if mode == "aseptic":
        return s["aseptic_ok"]
    if mode == "retort":
        return s["retort_ok"]
    if mode == "hot_fill":
        return s["temp_max"] >= HOT_FILL_C
    return True


def _light_factor(s: dict, p: dict) -> float:
    if p["sens"]["light"] < 2:
        return 1.0
    return 1.0 - 0.08 * p["sens"]["light"] * (1.0 - s["light_barrier"])


def _predict_life(props: dict, s: dict, p: dict, req: dict) -> dict:
    area = p["area_m2"] * s.get("area_factor", 1.0)
    w = p["pack_kg"]
    otr_eff = props["otr"] * req["gas_temp_factor"]
    wvtr_eff = props["wvtr"] * req["vapour_ratio"]

    t_moist = MAX_LIFE_DAYS
    if wvtr_eff * area > 1e-9:
        t_moist = min(MAX_LIFE_DAYS, req["moisture_allow_g"] / (wvtr_eff * area))

    mode = p["mode"]
    applied = mode if _mode_supported(s, mode) else "air"
    life_air = _life_at_temp(p, "air")
    life_prot = _life_at_temp(p, "protected")
    ceiling = life_prot if (applied == mode) else life_air

    t_o2 = None
    if p.get("o2_budget"):
        t_o2 = min(MAX_LIFE_DAYS, p["o2_budget"] * w / (otr_eff * area * ph.O2_IN_AIR))
        t_quality = min(ceiling, max(life_air, t_o2))
    else:
        t_quality = ceiling
    t_quality *= _light_factor(s, p)

    days = min(t_moist, t_quality)
    if t_moist <= t_quality:
        limit = "moisture gain" if req["moisture_direction"] == "gain" else "moisture loss"
    elif t_o2 is not None and t_o2 < ceiling and t_o2 >= life_air:
        limit = "oxidation"
    elif applied != mode:
        limit = f"spoilage without {MODES[mode].lower()}"
    elif t_o2 is not None and t_o2 < life_air:
        limit = "oxidation"
    else:
        limit = "the product's own stability"
    return {"days": days, "limit": limit, "moisture_days": t_moist, "oxygen_days": t_o2,
            "ceiling_days": ceiling, "applied_mode": applied,
            "otr_eff": otr_eff, "wvtr_eff": wvtr_eff, "area": area}


def _evaluate_food(s: dict, p: dict, req: dict, layer_db: dict) -> dict:
    idx, opts = _thickness_options(s, p)
    target = p["shelf_life"]
    chosen = None
    if idx is None:
        props = ph.stack_transmission(s["layers"], layer_db)
        chosen = (None, props, _predict_life(props, s, p, req))
    else:
        trials = []
        for um in opts:
            props = ph.stack_transmission(_with_thickness(s, idx, um), layer_db)
            trials.append((um, props, _predict_life(props, s, p, req)))
        chosen = next((t for t in trials if t[2]["days"] >= target), None)
        if chosen is None:
            best = max(trials, key=lambda t: t[2]["days"])
            # thickening the sealant only pays if it buys real shelf life
            chosen = best if best[2]["days"] > trials[0][2]["days"] * 1.05 else trials[0]
    um, props, life = chosen
    return _candidate(s, p, req, layer_db, idx, um, props, life, extra={})


def _evaluate_produce(s: dict, p: dict, req: dict, layer_db: dict) -> dict:
    idx, opts = _thickness_options(s, p)
    w = p["pack_kg"]
    area = p["area_m2"] * s.get("area_factor", 1.0)
    f_t = req["gas_temp_factor"]
    ventilated = bool(s.get("ventilated"))
    wants_vent = p["mode"] == "ventilated"
    perf = s.get("perforation")

    co2_max = p.get("co2_max", 100) / 100.0
    tgt_o2 = max(p["gas"]["o2"] / 100.0, 0.02)

    def atmosphere(props, holes):
        perm_o2 = props["otr"] * f_t * area
        perm_co2 = props["co2tr"] * f_t * area
        if perf:
            perm_o2 += holes * perf["o2_per_hole"]
            perm_co2 += holes * perf["o2_per_hole"] * perf["co2_ratio"]
        y_o2, y_co2, _ = ph.equilibrium_atmosphere(req["respiration_ml"], w, perm_o2, perm_co2)
        if wants_vent:
            return y_o2, y_co2, 0.0, 0.0
        # benefit grows with oxygen drawdown towards the target, then falls off below it
        if y_o2 >= tgt_o2:
            quality = (ph.O2_IN_AIR - y_o2) / (ph.O2_IN_AIR - tgt_o2)
        else:
            quality = 1.0 - 0.5 * (tgt_o2 - y_o2) / tgt_o2
        rank = quality - (1.0 if y_o2 < ANAEROBIC_O2 else 0.0) - (1.0 if y_co2 > co2_max else 0.0)
        return y_o2, y_co2, max(0.0, min(1.0, quality)), rank

    def trial(um):
        props = ph.stack_transmission(_with_thickness(s, idx, um), layer_db)
        if ventilated:
            return um, props, 0, ph.O2_IN_AIR, ph.CO2_IN_AIR, 0.0, 0.0
        if not perf:
            return (um, props, 0, *atmosphere(props, 0))
        if wants_vent:
            holes = max(4, round(40 * w))
            return (um, props, holes, *atmosphere(props, holes))
        base = max(1, round((req["pack_perm_o2"] - props["otr"] * f_t * area) / perf["o2_per_hole"]))
        best = None
        for k in (1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10):
            holes = max(1, round(base * k))
            res = (um, props, holes, *atmosphere(props, holes))
            if best is None or res[6] > best[6] + 1e-9:
                best = res
        return best

    trials = [trial(um) for um in opts] if idx is not None else [trial(None)]
    um, props, holes, y_o2, y_co2, quality, _ = max(trials, key=lambda t: t[6])

    cautions = []
    life_air = _life_at_temp(p, "air")
    life_prot = _life_at_temp(p, "protected")
    anaerobic = not ventilated and y_o2 < ANAEROBIC_O2
    co2_injury = not ventilated and y_co2 * 100 > p.get("co2_max", 100)

    if wants_vent:
        t_quality = life_air
        if ventilated:
            # a vented bag still holds some humidity; crops that must stay dry need open mesh
            keep = 0.5 if p.get("needs_dry") else 0.0
            t_quality *= (1.0 - keep) + keep * s.get("vent_factor", 1.0)
            if keep and s.get("vent_factor", 1.0) < 0.9:
                cautions.append("Vent holes alone leave the air around this crop too humid.")
        if not ventilated:
            t_quality *= 0.6
            cautions.append("A closed film traps humidity around this crop and brings on rot or sprouting.")
        limit = "the crop's own storage life"
    else:
        t_quality = life_air + (life_prot - life_air) * quality
        limit = "ripening and senescence"
        if anaerobic:
            t_quality = life_air * 0.3
            limit = "fermentation, the pack runs out of oxygen"
            cautions.append(f"Oxygen falls to {y_o2 * 100:.1f} %: the produce ferments and smells off.")
        elif co2_injury:
            t_quality = min(t_quality, life_air * 0.7)
            limit = "carbon dioxide injury"
            cautions.append(f"Carbon dioxide builds to {y_co2 * 100:.0f} %, above the {p['co2_max']} % this crop tolerates.")

    if p["temp"] < p.get("chill_min", -50):
        t_quality *= 0.5
        limit = "chilling injury"
        cautions.append(f"Stored below {p['chill_min']} °C this crop suffers chilling injury. Raise the temperature.")

    free = req["free_loss_pct_day"]
    if ventilated:
        loss = free * s.get("vent_factor", 1.0)
    else:
        loss = min(free, props["wvtr"] * req["vapour_ratio"] * area / (w * 1000.0) * 100.0)
    allow_pct = abs(p["moist_change"])
    t_moist = min(MAX_LIFE_DAYS, allow_pct / loss) if loss > 1e-9 else MAX_LIFE_DAYS
    if not ventilated and p.get("transp", 0.6) >= 1.5 and props["wvtr"] < 10:
        cautions.append("The pack runs near saturation: specify an anti-fog grade so droplets do not sit on the produce.")

    days = min(t_moist, t_quality)
    if t_moist < t_quality:
        limit = "wilting from water loss"
    life = {"days": days, "limit": limit, "moisture_days": t_moist, "oxygen_days": None,
            "ceiling_days": life_prot, "applied_mode": "ventilated" if ventilated else "emap",
            "otr_eff": props["otr"] * f_t, "wvtr_eff": props["wvtr"] * req["vapour_ratio"], "area": area}
    extra = {
        "perforations": holes if perf else None,
        "equilibrium": None if ventilated else {"o2": y_o2 * 100, "co2": y_co2 * 100},
        "ma_quality": quality,
        "infeasible": anaerobic,
        "cautions": cautions,
    }
    return _candidate(s, p, req, layer_db, idx, um, props, life, extra)


def _candidate(s, p, req, layer_db, idx, um, props, life, extra) -> dict:
    layers_out = []
    layers = _with_thickness(s, idx, um)
    for i, layer in enumerate(layers):
        lm = layer_db[layer["m"]]
        layers_out.append({
            "m": layer["m"], "name": lm["name"], "long": lm["long"], "family": lm["family"],
            "um": layer["um"], "role": layer["role"], "sized": i == idx,
            "share_o2": props["share_o2"][i], "share_w": props["share_w"][i],
        })
    area = life["area"]
    cost_m2 = props["material_cost_m2"] + s["conversion_cost_m2"]
    per_pack = area * cost_m2 * 1.08 + s.get("fixed_cost", 0.0)
    co2_pack_g = area * props["co2e_kg_m2"] * 1000.0 * 1.08
    label, _ = RECYCLE[s["recyclability"]]
    fmt = _pick_format(s, p, life["applied_mode"])
    return {
        "id": s["id"], "name": s["name"], "family": s["family"],
        "structure": " / ".join(f"{lo['name']} {lo['um']:g} µm" for lo in layers_out),
        "layers": layers_out,
        "thickness_um": props["thickness_um"], "gsm": props["gsm"],
        "otr": props["otr"], "wvtr": props["wvtr"], "co2tr": props["co2tr"], "beta": props["beta"],
        "otr_eff": life["otr_eff"], "wvtr_eff": life["wvtr_eff"],
        "seal": s["seal"], "tensile_mpa": s["tensile_mpa"],
        "puncture": s["puncture"], "puncture_label": PUNCTURE_LABEL[s["puncture"]],
        "temp_min": s["temp_min"], "temp_max": s["temp_max"],
        "light_barrier": s["light_barrier"], "grease": s["grease"],
        "format": fmt, "applied_mode": life["applied_mode"],
        "applied_mode_label": MODES[life["applied_mode"]],
        "map_suitable": bool(s["gas_flush_ok"] or s["vacuum_ok"]
                             or (p["is_produce"] and not s.get("ventilated"))),
        "perforations": extra.get("perforations"),
        "equilibrium": extra.get("equilibrium"),
        "ma_quality": extra.get("ma_quality"),
        "infeasible": bool(extra.get("infeasible")),
        "shelf_life": {
            "days": life["days"], "limit": life["limit"],
            "moisture_days": life["moisture_days"], "oxygen_days": life["oxygen_days"],
            "ceiling_days": life["ceiling_days"],
            "meets": life["days"] >= p["shelf_life"] * 0.999,
            "target": p["shelf_life"],
        },
        "area_m2": area,
        "cost": {"per_m2": cost_m2, "per_pack": per_pack, "per_1000": per_pack * 1000.0,
                 "per_kg_food": per_pack / p["pack_kg"]},
        "co2e": {"per_pack_g": co2_pack_g, "per_kg_food_g": co2_pack_g / p["pack_kg"]},
        "recyclability": {"class": s["recyclability"], "label": label,
                          "note": s["recycle_note"], "resin_code": s["resin_code"]},
        "cautions": list(extra.get("cautions", [])) + list(s.get("cautions", [])),
        "rigid": bool(s.get("rigid")),
    }


def _pick_format(s: dict, p: dict, applied_mode: str) -> str:
    formats = s["formats"]
    want = None
    if applied_mode == "vacuum":
        want = "vacuum"
    elif applied_mode == "map_gas":
        want = "tray"
    elif p["form"] in ("liquid", "paste") and not s.get("rigid"):
        want = "stand-up" if p["pack_kg"] <= 1.5 and p["form"] == "paste" else None
    elif p["form"] in ("powder", "granular") and p["pack_kg"] >= 0.2:
        want = "stand-up"
    if want:
        for f in formats:
            if want in f.lower():
                return f
    return formats[0]


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------

def _log_rank(value: float, lo: float, hi: float) -> float:
    """100 for the lowest value in the field, 0 for the highest, on a log scale."""
    if hi <= lo * 1.0001:
        return 100.0
    return 100.0 * (1.0 - math.log(value / lo) / math.log(hi / lo))


def _compat_score(c: dict, p: dict, req: dict) -> float:
    parts: list[tuple[float, float]] = []   # (score, weight)
    sens = p["sens"]
    if sens["light"] >= 1:
        parts.append((100.0 * c["light_barrier"], float(sens["light"])))
    if req["grease_needed"]:
        parts.append(({5: 100, 4: 90, 3: 60}.get(c["grease"], 25), 2.0))
    seal_w = 2.5 if p["form"] in ("liquid", "paste", "powder") or c["applied_mode"] != "air" else 1.0
    parts.append((c["seal"]["rating"] * 20.0, seal_w))
    if sens["aroma"] >= 2 and not p["is_produce"]:
        parts.append((100.0 if c["otr"] < 50 else 70.0 if c["otr"] < 500 else 35.0, float(sens["aroma"]) - 1))
    margin = min(p["temp"] - c["temp_min"], c["temp_max"] - p["temp"])
    parts.append((100.0 if margin >= 10 else 60.0 + 4.0 * margin, 1.0))
    if p["mode"] not in ("air", "emap", "ventilated"):
        parts.append((100.0 if c["applied_mode"] == p["mode"] else 30.0, 2.0))
    if p["is_produce"] and p["mode"] == "ventilated":
        parts.append((100.0 if c["applied_mode"] == "ventilated" else 30.0, 3.0))
    total_w = sum(w for _, w in parts)
    return sum(s * w for s, w in parts) / total_w


def score_candidates(cands: list[dict], p: dict, req: dict, ml_probs: dict | None) -> None:
    if not cands:
        return
    weights = dict(WEIGHTS[p["priority"]])
    if not ml_probs:
        weights["ml"] = 0
    total_w = sum(weights.values())

    costs = [c["cost"]["per_pack"] for c in cands]
    co2s = [c["co2e"]["per_pack_g"] for c in cands]
    p_max = max((ml_probs or {}).get(c["id"], 0.0) for c in cands) if ml_probs else 0.0

    for c in cands:
        ratio = c["shelf_life"]["days"] / p["shelf_life"]
        if p["priority"] == "shelf_life":
            barrier = 100.0 * min(ratio, 1.5) / 1.5 if ratio >= 1 else 66.0 * ratio ** 1.5
        else:
            barrier = 100.0 if ratio >= 1 else 100.0 * ratio ** 1.5
        if p["is_produce"] and p["mode"] == "emap" and c["ma_quality"] is not None:
            barrier = 0.6 * barrier + 40.0 * c["ma_quality"]
        if c["infeasible"]:
            barrier *= 0.3

        deficit = max(0, req["puncture_min"] - c["puncture"])
        mech = max(0.0, 100.0 - 30.0 * deficit)

        recycle_pts = RECYCLE[c["recyclability"]["class"]][1]
        sustain = 0.6 * recycle_pts + 0.4 * _log_rank(c["co2e"]["per_pack_g"], min(co2s), max(co2s))

        ml = 100.0 * (ml_probs.get(c["id"], 0.0) / p_max) if ml_probs and p_max > 0 else 0.0

        scores = {
            "barrier": barrier,
            "mech": mech,
            "compat": _compat_score(c, p, req),
            "cost": _log_rank(c["cost"]["per_pack"], min(costs), max(costs)),
            "sustain": sustain,
            "ml": ml,
        }
        total = sum(scores[k] * weights[k] for k in weights) / total_w
        scores["total"] = total
        c["scores"] = {k: round(v, 1) for k, v in scores.items()}
        c["ml_probability"] = (ml_probs or {}).get(c["id"])

    cands.sort(key=lambda c: (c["shelf_life"]["meets"] and not c["infeasible"], c["scores"]["total"]),
               reverse=True)


# --------------------------------------------------------------------------
# Explanations
# --------------------------------------------------------------------------

def _reasons(c: dict, p: dict, req: dict) -> list[str]:
    out = []
    life = c["shelf_life"]
    if life["meets"]:
        out.append(f"Predicted shelf life is {life['days']:.0f} days against a target of {life['target']:.0f}.")
    if req.get("wvtr_max") is not None and c["wvtr"] <= req["wvtr_max"]:
        verb = "gain" if req["moisture_direction"] == "gain" else "loss"
        out.append(f"Water-vapour transmission of {_num(c['wvtr'])} g/m²·day is inside the "
                   f"{_num(req['wvtr_max'])} limit, so moisture {verb} stays within tolerance.")
    if req.get("otr_max") is not None and c["otr"] <= req["otr_max"]:
        out.append(f"Oxygen transmission of {_num(c['otr'])} cc/m²·day·atm is inside the "
                   f"{_num(req['otr_max'])} limit.")
    if c["equilibrium"] and not c["infeasible"] and p["mode"] == "emap":
        eq = c["equilibrium"]
        out.append(f"The pack settles at {eq['o2']:.0f} % oxygen and {eq['co2']:.0f} % carbon dioxide; "
                   f"the target is {p['gas']['o2']} % and {p['gas']['co2']} %.")
    if c["perforations"]:
        out.append(f"{c['perforations']} micro-perforations of 100 µm per pack supply the oxygen "
                   "the film alone cannot.")
    if c["applied_mode"] == "ventilated" and p["mode"] == "ventilated":
        out.append("Open structure keeps air moving over the crop and stops condensation.")
    if req["light_barrier_needed"] and c["light_barrier"] >= 0.85:
        out.append(f"Blocks {c['light_barrier'] * 100:.0f} % of light, which protects "
                   f"{'the fat from rancidity' if p['fat'] >= 10 else 'colour and vitamins'}.")
    if c["applied_mode"] == p["mode"] and p["mode"] in ("n2_flush", "map_gas", "vacuum", "hermetic",
                                                           "retort", "aseptic", "hot_fill"):
        out.append({
            "n2_flush": "Gas-tight enough to hold a nitrogen flush for the whole shelf life.",
            "map_gas": "Gas-tight enough to hold the modified atmosphere.",
            "vacuum": "Stays tight around the product under vacuum without pinholing.",
            "hermetic": "Airtight liner lets oxygen fall low enough to kill storage insects.",
            "retort": "Survives sterilisation at 121 °C.",
            "aseptic": "Can be sterilised and sealed on an aseptic filler.",
            "hot_fill": f"Holds its shape at the {HOT_FILL_C} °C filling temperature.",
        }[p["mode"]])
    if c["puncture"] >= req["puncture_min"] and p["transport_level"] >= 3:
        out.append(f"{c['puncture_label']} puncture resistance suits {TRANSPORT[p['transport']][1].lower()}.")
    if c["recyclability"]["class"] in ("recyclable", "reusable", "compostable"):
        out.append(f"{c['recyclability']['label']}: {c['recyclability']['note']}")
    return out


def _dynamic_cautions(c: dict, p: dict, req: dict) -> list[str]:
    out = []
    life = c["shelf_life"]
    if not life["meets"]:
        out.append(f"Reaches {life['days']:.0f} days, short of the {life['target']:.0f}-day target. "
                   f"Shelf life is limited by {life['limit']}.")
    if c["puncture"] < req["puncture_min"]:
        out.append(f"Puncture resistance is {c['puncture_label'].lower()}; "
                   f"{TRANSPORT[p['transport']][1].lower()} needs better. Pack in a corrugated carton.")
    if p["mode"] not in ("air", "emap", "ventilated") and c["applied_mode"] != p["mode"]:
        out.append(f"Cannot be used for {MODES[p['mode']].lower()}, so the product keeps only as long as in air.")
    if req["light_barrier_needed"] and c["light_barrier"] < 0.5:
        out.append("Lets light through: print it opaque or keep it in a carton.")
    if p["rh"] >= 85 and any(layer["m"] == "EVOH" for layer in c["layers"]) and p["storage"] == "ambient":
        out.append("At this humidity the EVOH layer delivers less oxygen barrier than its datasheet value.")
    return out


def _num(v: float) -> str:
    if v >= 100:
        return f"{v:,.0f}"
    if v >= 10:
        return f"{v:.0f}"
    if v >= 1:
        return f"{v:.1f}"
    return f"{v:.2f}"


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------

def recommend(inp: dict, db: dict, ml_model=None) -> dict:
    """db: {"commodities": {id: ...}, "structures": [...], "layers": {...}}"""
    p = build_profile(inp, db["commodities"])
    req = compute_requirements(p)

    cands, rejected = [], []
    for s in db["structures"]:
        reason = reject_reason(s, p)
        if reason:
            rejected.append({"id": s["id"], "name": s["name"], "reason": reason})
            continue
        if p["is_produce"]:
            cands.append(_evaluate_produce(s, p, req, db["layers"]))
        else:
            cands.append(_evaluate_food(s, p, req, db["layers"]))

    ml_probs, ml_info = None, {"available": False}
    if ml_model is not None:
        ml_probs = ml_model.predict(p)
        ml_info = ml_model.info()
        ml_info["available"] = True
        names = {s["id"]: s["name"] for s in db["structures"]}
        top = sorted(ml_probs.items(), key=lambda kv: kv[1], reverse=True)[:3]
        ml_info["top"] = [{"id": k, "name": names.get(k, k), "probability": round(v, 3)} for k, v in top if v > 0]

    score_candidates(cands, p, req, ml_probs)
    for c in cands:
        c["reasons"] = _reasons(c, p, req)
        c["cautions"] = _dynamic_cautions(c, p, req) + c["cautions"]

    warnings = []
    ok = [c for c in cands if c["shelf_life"]["meets"] and not c["infeasible"]]
    if cands and not ok:
        longest = max(cands, key=lambda c: c["shelf_life"]["days"])
        warnings.append(
            f"No structure in the database reaches {p['shelf_life']:.0f} days under these conditions. "
            f"The longest is {longest['shelf_life']['days']:.0f} days with {longest['name']}. "
            "Lower the storage temperature or shorten the target."
        )
    if not cands:
        warnings.append("Every structure in the database was ruled out. Check the pack weight, "
                        "storage temperature and product form.")
    life = p["life"]
    if not p["is_produce"] and p["temp"] > life["ref_temp"] + 8 and p["storage"] != "ambient":
        warnings.append(f"{p['name']} is normally held near {life['ref_temp']} °C. At {p['temp']:.0f} °C it "
                        "spoils several times faster whatever the pack.")

    pool = ok or cands
    picks = {}
    if pool:
        picks = {
            "cheapest": min(pool, key=lambda c: c["cost"]["per_pack"])["id"],
            "greenest": max(pool, key=lambda c: c["scores"]["sustain"])["id"],
            "longest": max(pool, key=lambda c: c["shelf_life"]["days"])["id"],
        }

    return {
        "profile": {
            "id": p["id"], "name": p["name"], "category": p.get("category"),
            "form": p["form"], "form_label": FORMS.get(p["form"], p["form"]),
            "regime": p["regime"], "template": p.get("template"),
            "moisture": p["moisture"], "fat": p["fat"], "ph": p["ph"], "aw": round(p["aw"], 3),
            "resp20": p["resp20"], "is_produce": p["is_produce"],
            "shelf_life": p["shelf_life"], "storage": p["storage"], "temp": p["temp"], "rh": p["rh"],
            "transport": p["transport"], "transport_label": TRANSPORT[p["transport"]][1],
            "pack_g": p["pack_kg"] * 1000.0, "priority": p["priority"],
            "mode": p["mode"], "mode_label": MODES[p["mode"]], "note": p.get("note"),
        },
        "requirements": req,
        "candidates": cands,
        "picks": picks,
        "rejected": rejected,
        "ml": ml_info,
        "warnings": warnings,
    }


def library(db: dict) -> list[dict]:
    """Every structure at its nominal thickness, for the materials library."""
    out = []
    for s in db["structures"]:
        props = ph.stack_transmission(s["layers"], db["layers"])
        layers = []
        for i, layer in enumerate(s["layers"]):
            lm = db["layers"][layer["m"]]
            layers.append({"m": layer["m"], "name": lm["name"], "long": lm["long"], "family": lm["family"],
                           "um": layer["um"], "role": layer["role"], "adjust": layer.get("adjust"),
                           "share_o2": props["share_o2"][i], "share_w": props["share_w"][i]})
        label, _ = RECYCLE[s["recyclability"]]
        uses = []
        if produce_only(s):
            uses.append("Fresh produce")
        if s["vacuum_ok"]:
            uses.append("Vacuum")
        if s["gas_flush_ok"]:
            uses.append("Gas flush")
        if s["retort_ok"]:
            uses.append("Retort")
        if s["aseptic_ok"]:
            uses.append("Aseptic")
        if s["liquid_ok"]:
            uses.append("Liquids")
        if s["temp_min"] <= -18:
            uses.append("Frozen")
        out.append({
            "id": s["id"], "name": s["name"], "family": s["family"], "layers": layers,
            "structure": " / ".join(f"{lo['name']} {lo['um']:g} µm" for lo in layers),
            "thickness_um": props["thickness_um"], "gsm": props["gsm"],
            "otr": props["otr"], "wvtr": props["wvtr"], "beta": props["beta"],
            "cost_m2": props["material_cost_m2"] + s["conversion_cost_m2"],
            "co2e_g_m2": props["co2e_kg_m2"] * 1000.0,
            "seal": s["seal"], "tensile_mpa": s["tensile_mpa"], "puncture": s["puncture"],
            "puncture_label": PUNCTURE_LABEL[s["puncture"]],
            "temp_min": s["temp_min"], "temp_max": s["temp_max"],
            "light_barrier": s["light_barrier"], "max_pack_kg": s["max_pack_kg"],
            "formats": s["formats"], "uses": uses,
            "recyclability": {"class": s["recyclability"], "label": label,
                              "note": s["recycle_note"], "resin_code": s["resin_code"]},
            "cautions": s.get("cautions", []),
            "perforated": bool(s.get("perforation")), "ventilated": bool(s.get("ventilated")),
        })
    return out
