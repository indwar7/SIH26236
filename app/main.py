"""HTTP API. Run locally with:  uvicorn app.main:app --reload"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import db, trace
from .engine import core
from .engine.ml import ForestModel

ROOT = Path(__file__).resolve().parent.parent
DATA = db.load()
MODEL = ForestModel.load(Path(__file__).parent / "data" / "model.json")
STRUCTURES = {s["id"]: s for s in DATA["structures"]}

app = FastAPI(title="Parat", docs_url="/api/docs", openapi_url="/api/openapi.json")


class RecommendIn(BaseModel):
    commodity_id: str = "custom"
    custom_name: Optional[str] = Field(None, max_length=60)
    form: Optional[Literal["produce", "solid", "fragile", "powder", "granular", "liquid", "paste"]] = None
    moisture: Optional[float] = Field(None, ge=0, le=100)
    fat: Optional[float] = Field(None, ge=0, le=100)
    ph: Optional[float] = Field(None, ge=0, le=14)
    respiration: Optional[float] = Field(None, ge=0, le=1000)
    shelf_life_days: Optional[float] = Field(None, ge=1, le=1500)
    storage_type: Optional[Literal["ambient", "chilled", "frozen"]] = None
    temp_c: Optional[float] = Field(None, ge=-40, le=60)
    rh: Optional[float] = Field(None, ge=10, le=100)
    transport: Optional[Literal["local", "regional", "long_haul", "export"]] = None
    pack_g: Optional[float] = Field(None, ge=10, le=50000)
    priority: Optional[Literal["balanced", "cost", "sustainability", "shelf_life"]] = None


class RecordIn(BaseModel):
    brief: RecommendIn
    structure_id: str
    producer: str = Field(..., min_length=1, max_length=60)
    batch: str = Field(..., min_length=1, max_length=30)
    packed_on: date


@app.get("/api/health")
def health():
    return {"ok": True, "structures": len(DATA["structures"]), "commodities": len(DATA["commodities"]),
            "model": MODEL.info() if MODEL else None}


@app.get("/api/commodities")
def commodities():
    keys = ("id", "name", "category", "form", "moisture", "fat", "ph", "resp20", "storage",
            "temp", "rh", "shelf_life", "pack_g", "mode", "note")
    return [{k: c.get(k) for k in keys} | {"mode_label": core.MODES[c["mode"]]}
            for c in DATA["commodities"].values()]


@app.get("/api/structures")
def structures():
    return core.library(DATA)


@app.post("/api/recommend")
def recommend(body: RecommendIn):
    return core.recommend(body.model_dump(), DATA, MODEL)


def _expand(payload: dict) -> dict:
    """Rebuild the full record from the compact token payload."""
    brief = payload["i"]
    result = core.recommend(brief, DATA, MODEL)
    cand = next((c for c in result["candidates"] if c["id"] == payload["s"]), None)
    if cand is None:
        raise HTTPException(422, "This record names a structure that no longer fits the product.")
    packed = date.fromisoformat(payload["d"])
    days = int(cand["shelf_life"]["days"])
    return {
        "producer": payload["p"], "batch": payload["b"],
        "packed_on": packed.isoformat(),
        "best_before": (packed + timedelta(days=days)).isoformat(),
        "profile": result["profile"],
        "map": result["requirements"]["map"],
        "secondary": result["requirements"]["secondary"],
        "pack": cand,
    }


@app.post("/api/records")
def create_record(body: RecordIn, request: Request):
    if body.structure_id not in STRUCTURES:
        raise HTTPException(404, "Unknown structure.")
    brief = {k: v for k, v in body.brief.model_dump().items() if v is not None}
    payload = {"v": 1, "i": brief, "s": body.structure_id, "p": body.producer.strip(),
               "b": body.batch.strip(), "d": body.packed_on.isoformat()}
    record = _expand(payload)
    token = trace.encode(payload)
    origin = request.headers.get("origin") or str(request.base_url).rstrip("/")
    url = f"{origin}/#/trace/{token}"
    return {"token": token, "url": url, "qr_svg": trace.qr_svg(url), "record": record}


@app.get("/api/trace/{token}")
def read_record(token: str, request: Request):
    try:
        payload = trace.decode(token)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    origin = str(request.base_url).rstrip("/")
    forwarded = request.headers.get("x-forwarded-host")
    if forwarded:
        origin = f"{request.headers.get('x-forwarded-proto', 'https')}://{forwarded}"
    url = f"{origin}/#/trace/{token}"
    return {"token": token, "url": url, "qr_svg": trace.qr_svg(url), "record": _expand(payload)}


# Local development: serve the frontend too. On Vercel the CDN serves public/.
if (ROOT / "public").is_dir():
    app.mount("/", StaticFiles(directory=ROOT / "public", html=True), name="site")


