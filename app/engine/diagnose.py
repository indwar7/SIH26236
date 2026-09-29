"""Evaluate one pack a user already has, and explain why their food spoiled.

Everything here reuses the engine in core.py; this module only frames the
results in plain language for people who are not packaging specialists.
"""
from __future__ import annotations

import copy

from . import core

# Everyday packs a user can pick, mapped to the closest structure in the database.
CURRENT_PACKS = {
    "thin_bag":     ("ldpe", "Thin plastic bag, like a bread bag"),
    "thick_bag":    ("hdpe-film", "Thick plastic bag or grocery bag"),
    "clear_pouch":  ("bopp-cpp", "Clear shiny plastic pouch"),
    "silver_pouch": ("bopp-metbopp", "Silver pouch, like a chips packet"),
    "foil_pouch":   ("pet-alu-pe", "Foil pouch, like a coffee sachet"),
    "paper_bag":    ("kraft-pe", "Paper bag with a plastic lining"),
    "jar":          ("pet-bottle", "Plastic jar or bottle"),
    "sack":         ("woven-pp-liner", "Woven sack with a plastic liner"),
    "mesh":         ("leno", "Net or mesh bag, or an open crate"),
    "cling":        ("pvc-stretch", "Tray with cling film"),
    "vacuum":       ("pa-pe", "Vacuum-sealed pouch"),
}

SYMPTOMS = {
    "soft":    "It went soft or soggy",
    "rancid":  "It smells stale or rancid",
    "mould":   "Mould or fungus grew on it",
    "rotten":  "It rotted, went slimy or smells sour",
    "dried":   "It dried out, shrank or wrinkled",
    "torn":    "The pack tore, leaked or burst",
    "faded":   "It lost colour or flavour",
    "insects": "Insects got in",
}


# Gauge of the everyday pack, where it differs from the database's nominal value.
GAUGE_UM = {"thin_bag": 30, "thick_bag": 60}


def evaluate_one(inp: dict, db: dict, structure_id: str, gauge_um: float | None = None) -> dict:
    """Predict how one structure performs for this brief, as the user has it: no resizing,
    and even if the engine would rule it out."""
    base = next((x for x in db["structures"] if x["id"] == structure_id), None)
    if base is None:
        raise KeyError(structure_id)
    s = copy.deepcopy(base)
    for layer in s["layers"]:
        if "adjust" in layer:
            if gauge_um:
                layer["um"] = gauge_um
            del layer["adjust"]
    p = core.build_profile(inp, db["commodities"])
    req = core.compute_requirements(p)
    if p["is_produce"]:
        cand = core._evaluate_produce(s, p, req, db["layers"])
    else:
        cand = core._evaluate_food(s, p, req, db["layers"])
    cand["reject_reason"] = core.reject_reason(s, p)
    return {"pack": cand, "requirements": req, "profile": p}


def _x(a: float, b: float) -> str:
    r = a / b
    return f"{r:,.0f} times" if r >= 10 else f"{r:.1f} times"


def diagnose(inp: dict, db: dict, current: str, symptom: str, lasted_days: float | None, ml_model=None) -> dict:
    sid, pack_label = CURRENT_PACKS[current]
    ev = evaluate_one(inp, db, sid, GAUGE_UM.get(current))
    cur, req, p = ev["pack"], ev["requirements"], ev["profile"]
    best = core.recommend(inp, db, ml_model)
    top = best["candidates"][0] if best["candidates"] else None

    evidence: list[str] = []
    tips: list[str] = []
    title, cause = "", ""
    warm = p["temp"] >= 30

    if symptom == "soft":
        title = "Moisture from the air is getting in"
        cause = (f"{p['name']} is dry, and a {pack_label.lower()} lets water vapour through. "
                 "Over a few weeks the food soaks it up and loses its crunch.")
        if req.get("wvtr_max"):
            evidence.append(f"Your pack lets through {core._num(cur['wvtr'])} g of water vapour per m² per day. "
                            f"This food can take at most {core._num(req['wvtr_max'])}, so your pack is "
                            f"{_x(cur['wvtr'], req['wvtr_max'])} too leaky.")
        tips.append("Seal the pack fully; a folded or clipped top lets humid air in.")
        if p["rh"] >= 75:
            tips.append("Your storage air is very humid. Keep stock off the floor and away from walls.")
    elif symptom == "rancid":
        title = "Oxygen is reaching the oil"
        cause = (f"The oil or fat in {p['name'].lower()} reacts with oxygen and turns stale. "
                 f"A {pack_label.lower()} lets too much air through" +
                 (", and light speeds it up." if cur["light_barrier"] < 0.5 else "."))
        if req.get("otr_max"):
            evidence.append(f"Your pack lets through {core._num(cur['otr'])} cc of oxygen per m² per day. "
                            f"This food can take at most {core._num(req['otr_max'])}, so your pack is "
                            f"{_x(cur['otr'], req['otr_max'])} too open to air.")
        if cur["light_barrier"] < 0.5:
            evidence.append(f"Your pack blocks only {cur['light_barrier'] * 100:.0f} % of light.")
        tips.append("Flush the pack with nitrogen before sealing. Small nitrogen flushing machines cost less than a sealer.")
        if warm:
            tips.append(f"At {p['temp']:.0f} °C fats go rancid about twice as fast as at 20 °C. Store in the coolest room you have.")
    elif symptom == "mould":
        title = "Moisture and warmth are letting mould grow"
        cause = ("Mould needs water, air and warmth. " +
                 ("The food itself is moist, so the pack alone cannot stop it; air inside the pack and warm storage let it grow."
                  if p["aw"] >= 0.85 else
                  f"The food picked up moisture through the {pack_label.lower()} until mould could grow."))
        if p["aw"] < 0.85 and req.get("wvtr_max"):
            evidence.append(f"Your pack lets in {_x(cur['wvtr'], req['wvtr_max'])} more moisture than this food can take.")
        tips.append("Let the food cool fully before packing. Warm food sweats inside the pack.")
        if p["aw"] >= 0.85:
            tips.append("Remove the air: a vacuum pack or a carbon dioxide flush slows mould a lot.")
            if p["storage"] == "ambient":
                tips.append("Moist foods like this keep far longer in a fridge.")
    elif symptom == "rotten":
        if p["is_produce"]:
            eq = cur.get("equilibrium")
            if cur.get("infeasible") or (eq and eq["o2"] < 3):
                title = "The produce is suffocating in a closed pack"
                cause = ("Fruit and vegetables keep breathing after harvest. In a sealed bag they use up the oxygen, "
                         "start fermenting and rot from inside.")
                if eq:
                    evidence.append(f"Oxygen in your pack falls to about {eq['o2']:.1f} %. Near 1 to 2 % the produce starts to ferment, "
                                    "and any rise in temperature pushes it lower.")
                tips.append("Use a bag with tiny holes (micro-perforated) or vented bags so the produce can breathe.")
            else:
                title = "It is ripening too fast"
                cause = (f"At {p['temp']:.0f} °C {p['name'].lower()} breathes quickly and ripens fast. "
                         "The pack is letting in too much air to slow it down.")
                if eq:
                    evidence.append(f"Oxygen in your pack stays at about {eq['o2']:.0f} %; around "
                                    f"{p['gas']['o2']} % would slow ripening.")
            if p.get("chill_min", -50) < p["temp"] and p["temp"] > 15:
                tips.append("Cooling slows breathing more than any bag. Even a few degrees cooler helps.")
            tips.append("Do not pack produce that is bruised or wet; one rotten piece spreads to the rest.")
        else:
            title = "Bacteria are spoiling the food"
            cause = ("This food is moist enough for bacteria to grow. Packaging slows it only if the air is removed "
                     "and the food stays cold.")
            tips.append("Keep it at 4 °C or colder from packing to sale.")
            tips.append("Vacuum packing or a gas flush with carbon dioxide can double the life.")
    elif symptom == "dried":
        title = "Water is escaping through the pack"
        cause = (f"{p['name']} loses water to dry air. A {pack_label.lower()} lets it escape too fast.")
        evidence.append(f"Predicted weight loss in your pack reaches the limit in about {cur['shelf_life']['moisture_days']:.0f} days.")
        tips.append("Keep humidity high in storage, and do not store near fans or cold-room evaporators.")
    elif symptom == "torn":
        title = "The pack is not strong enough for the trip"
        cause = (f"A {pack_label.lower()} has {cur['puncture_label'].lower()} puncture resistance. "
                 f"{core.TRANSPORT[p['transport']][1]} needs better.")
        evidence.append(f"Your pack scores {cur['puncture']} of 5 for puncture resistance; this trip needs {req['puncture_min']}.")
        tips.append("Put packs inside a corrugated carton instead of a loose sack.")
        tips.append("Leave a little headspace; overfilled packs burst at the seal.")
    elif symptom == "faded":
        title = "Light and air are fading it"
        cause = "Light and oxygen break down colour, vitamins and aroma."
        evidence.append(f"Your pack blocks {cur['light_barrier'] * 100:.0f} % of light.")
        tips.append("Use an opaque or silver pack, or keep packs in a closed carton.")
    elif symptom == "insects":
        title = "The pack is not airtight"
        cause = "Storage insects get in through gaps, stitch holes and thin film, or were already in the grain as eggs."
        tips.append("Use an airtight (hermetic) bag. Insects inside use up the oxygen and die without chemicals.")
        tips.append("Dry grain below 12 % moisture and clean it before bagging.")

    predicted = cur["shelf_life"]["days"]
    if lasted_days:
        evidence.append(f"In your pack Parat predicts about {predicted:.0f} days; you saw {lasted_days:.0f}.")
    if cur.get("reject_reason"):
        evidence.append(f"Parat would not recommend this pack for {p['name'].lower()}: {cur['reject_reason'][0].lower()}{cur['reject_reason'][1:]}")

    return {
        "title": title,
        "cause": cause,
        "evidence": evidence,
        "tips": tips,
        "current": {"label": pack_label, "structure_id": sid, "pack": cur},
        "recommended": top,
        "profile": best["profile"],
        "picks": best["picks"],
        "gain_days": (top["shelf_life"]["days"] - predicted) if top else None,
    }
