"""Materials and commodity database.

The JSON files in app/data are the source of truth. They are loaded into
SQLite at start-up so the data can be queried and inspected; the engine reads
it back from there.
"""
from __future__ import annotations

import json
import os
import sqlite3
import tempfile
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"

SCHEMA = """
DROP TABLE IF EXISTS layer_materials;
DROP TABLE IF EXISTS structures;
DROP TABLE IF EXISTS commodities;
CREATE TABLE layer_materials (
    key TEXT PRIMARY KEY, name TEXT, family TEXT,
    density REAL, price_inr_kg REAL, co2e_kg_kg REAL, data TEXT NOT NULL
);
CREATE TABLE structures (
    id TEXT PRIMARY KEY, position INTEGER, name TEXT, family TEXT,
    recyclability TEXT, max_pack_kg REAL, data TEXT NOT NULL
);
CREATE TABLE commodities (
    id TEXT PRIMARY KEY, position INTEGER, name TEXT, category TEXT,
    form TEXT, storage TEXT, data TEXT NOT NULL
);
"""


def _read(name: str):
    with open(DATA_DIR / name, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _db_path() -> str:
    explicit = os.environ.get("PARAT_DB")
    if explicit:
        return explicit
    local = Path(__file__).resolve().parent.parent / "parat.db"
    try:
        with open(local, "a"):
            pass
        return str(local)
    except OSError:
        # read-only deployment (serverless): fall back to the temp directory
        return str(Path(tempfile.gettempdir()) / "parat.db")


def _seed(conn: sqlite3.Connection) -> None:
    layers = {k: v for k, v in _read("layer_materials.json").items() if not k.startswith("_")}
    structures = _read("structures.json")
    commodities = _read("commodities.json")
    conn.executescript(SCHEMA)
    conn.executemany(
        "INSERT INTO layer_materials VALUES (?,?,?,?,?,?,?)",
        [(k, v["name"], v["family"], v["density"], v["price"], v["co2e"], json.dumps(v))
         for k, v in layers.items()],
    )
    conn.executemany(
        "INSERT INTO structures VALUES (?,?,?,?,?,?,?)",
        [(s["id"], i, s["name"], s["family"], s["recyclability"], s["max_pack_kg"], json.dumps(s))
         for i, s in enumerate(structures)],
    )
    conn.executemany(
        "INSERT INTO commodities VALUES (?,?,?,?,?,?,?)",
        [(c["id"], i, c["name"], c["category"], c["form"], c["storage"], json.dumps(c))
         for i, c in enumerate(commodities)],
    )
    conn.commit()


def load() -> dict:
    """Seed SQLite from the JSON files and return the data the engine needs."""
    try:
        conn = sqlite3.connect(_db_path())
        _seed(conn)
    except sqlite3.Error:
        conn = sqlite3.connect(":memory:")
        _seed(conn)
    try:
        layers = {k: json.loads(d) for k, d in conn.execute("SELECT key, data FROM layer_materials")}
        structures = [json.loads(d) for (d,) in conn.execute("SELECT data FROM structures ORDER BY position")]
        commodities = {cid: json.loads(d)
                       for cid, d in conn.execute("SELECT id, data FROM commodities ORDER BY position")}
    finally:
        conn.close()
    return {"layers": layers, "structures": structures, "commodities": commodities}
