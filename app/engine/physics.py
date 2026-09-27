"""Physical relations used by the engine.

Datasheet conventions assumed throughout:
  OTR  in cc / m² · day · atm, measured at 23 °C, 0 % RH
  WVTR in g  / m² · day,       measured at 38 °C, 90 % RH
"""
from __future__ import annotations

import math

R_GAS = 8.314            # J / mol · K
T_OTR_TEST_K = 296.15    # 23 °C
EA_GAS = 40_000.0        # J / mol, activation energy of O2 / CO2 permeation in common films
O2_IN_AIR = 0.21
CO2_IN_AIR = 0.0004
ML_CO2_PER_MG = 0.509    # 22.4 l / 44 g


def psat_kpa(t_c: float) -> float:
    """Saturation vapour pressure of water (Tetens); over ice below 0 °C."""
    if t_c >= 0:
        return 0.61078 * math.exp(17.27 * t_c / (t_c + 237.3))
    return 0.61078 * math.exp(21.875 * t_c / (t_c + 265.5))


DP_WVTR_TEST = 0.9 * psat_kpa(38.0)   # vapour-pressure difference in the WVTR test, kPa


def gas_temp_factor(t_c: float) -> float:
    """Gas permeability at t_c relative to the 23 °C test value (Arrhenius)."""
    t_k = t_c + 273.15
    return math.exp(-EA_GAS / R_GAS * (1.0 / t_k - 1.0 / T_OTR_TEST_K))


_ISOTHERM = [
    (0, 0.05), (2, 0.15), (5, 0.30), (8, 0.45), (10, 0.52), (12, 0.60), (14, 0.67),
    (18, 0.76), (25, 0.86), (35, 0.93), (50, 0.97), (70, 0.985), (100, 0.995),
]


def aw_from_moisture(moisture_pct: float) -> float:
    """Generic sorption isotherm: water activity from moisture (% wet basis)."""
    m = max(0.0, min(100.0, moisture_pct))
    for (m0, a0), (m1, a1) in zip(_ISOTHERM, _ISOTHERM[1:]):
        if m <= m1:
            return a0 + (a1 - a0) * (m - m0) / (m1 - m0)
    return _ISOTHERM[-1][1]


def q10_factor(q10: float, t_ref: float, t_c: float) -> float:
    """Multiplier on shelf life when stored at t_c instead of t_ref."""
    return q10 ** ((t_ref - t_c) / 10.0)


def respiration_at(resp20: float, q10: float, t_c: float) -> float:
    """Respiration rate (mg CO2 / kg · h) at t_c from the 20 °C value."""
    return resp20 * q10 ** ((t_c - 20.0) / 10.0)


def stack_transmission(layers: list[dict], layer_db: dict) -> dict:
    """Series-resistance model of a laminate.

    1 / TR_total = sum(1 / TR_layer). Returns totals, each layer's share of the
    resistance, and mass, cost and carbon per square metre.
    """
    r_o2, r_w, r_co2 = [], [], []
    gsm = cost = co2e = total_um = 0.0
    for layer in layers:
        lm = layer_db[layer["m"]]
        um = float(layer["um"])
        if "otr_fixed" in lm:
            otr, wvtr = lm["otr_fixed"], lm["wvtr_fixed"]
        else:
            otr, wvtr = lm["p_o2"] / um, lm["p_w"] / um
        r_o2.append(1.0 / otr)
        r_w.append(1.0 / wvtr)
        r_co2.append(1.0 / (otr * lm.get("beta", 4.0)))
        g = um * lm["density"]
        gsm += g
        cost += g * lm["price"] / 1000.0
        co2e += g * lm["co2e"] / 1000.0
        total_um += um
    so2, sw, sco2 = sum(r_o2), sum(r_w), sum(r_co2)
    otr = 1.0 / so2
    co2tr = 1.0 / sco2
    return {
        "otr": otr,
        "wvtr": 1.0 / sw,
        "co2tr": co2tr,
        "beta": co2tr / otr,
        "share_o2": [r / so2 for r in r_o2],
        "share_w": [r / sw for r in r_w],
        "gsm": gsm,
        "material_cost_m2": cost,
        "co2e_kg_m2": co2e,
        "thickness_um": total_um,
    }


def equilibrium_atmosphere(resp_ml_air: float, weight_kg: float, perm_o2: float,
                           perm_co2: float, km: float = 0.03) -> tuple[float, float, float]:
    """Steady-state O2 and CO2 fractions inside a pack of respiring produce.

    resp_ml_air: O2 uptake in air, ml / kg · h
    perm_o2, perm_co2: whole-pack permeance, cc / day · atm
    Respiration slows at low oxygen (Michaelis-Menten, normalised to air).
    Returns (y_o2, y_co2, respiration at equilibrium in ml / kg · h).
    """
    def resp(y: float) -> float:
        return resp_ml_air * (y * (km + O2_IN_AIR)) / (O2_IN_AIR * (km + y))

    lo, hi = 0.0, O2_IN_AIR
    for _ in range(40):
        mid = (lo + hi) / 2.0
        supply = perm_o2 * (O2_IN_AIR - mid)
        demand = resp(mid) * weight_kg * 24.0
        if supply > demand:
            lo = mid
        else:
            hi = mid
    y_o2 = (lo + hi) / 2.0
    r_eq = resp(y_o2)
    y_co2 = CO2_IN_AIR + (r_eq * weight_kg * 24.0) / perm_co2 if perm_co2 > 0 else 1.0
    return y_o2, min(y_co2, 1.0), r_eq
