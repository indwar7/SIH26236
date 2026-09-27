"""Traceability records.

A record is packed into a signed token that travels inside the QR code, so a
label can be verified without a server-side record store.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import zlib

import segno

SIG_BYTES = 6


def _secret() -> bytes:
    return os.environ.get("PARAT_SECRET", "parat-dev-secret-change-me").encode()


def encode(payload: dict) -> str:
    raw = zlib.compress(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode(), 9)
    sig = hmac.new(_secret(), raw, hashlib.sha256).digest()[:SIG_BYTES]
    return base64.urlsafe_b64encode(sig + raw).decode().rstrip("=")


def decode(token: str) -> dict:
    """Raises ValueError if the token is malformed or its signature does not match."""
    try:
        blob = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        sig, raw = blob[:SIG_BYTES], blob[SIG_BYTES:]
        expected = hmac.new(_secret(), raw, hashlib.sha256).digest()[:SIG_BYTES]
        if not hmac.compare_digest(sig, expected):
            raise ValueError("signature mismatch")
        return json.loads(zlib.decompress(raw).decode())
    except (ValueError, zlib.error, UnicodeDecodeError) as exc:
        raise ValueError("This code is damaged or was not issued by Parat.") from exc


def qr_svg(url: str) -> str:
    qr = segno.make(url, error="m")
    return qr.svg_inline(scale=4, border=2, dark="#0e2a33", light="#ffffff", omitsize=True)
