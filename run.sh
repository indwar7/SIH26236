#!/bin/sh
# Start Parat locally on http://localhost:8000
cd "$(dirname "$0")"
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt; }
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
