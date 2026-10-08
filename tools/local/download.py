"""Checksum-verified source prefetch avoids Surfer's premature stream completion."""
from __future__ import annotations

import hashlib
import os
import re
import time
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict
from urllib.parse import urlsplit

from core import Context, DevError, no_symlink_ancestors, read_json


def _official_response(url: str):
    response = urllib.request.urlopen(urllib.request.Request(url, headers={
        "User-Agent": "Zen-local-development/1", "Accept-Encoding": "identity"}), timeout=60)
    actual = urlsplit(response.geturl())
    if actual.scheme != "https" or not (actual.hostname or "").endswith((".mozilla.org", ".mozilla.net")):
        response.close()
        raise DevError("Mozilla source request redirected outside official HTTPS hosting")
    return response


def _sha512(path: Path) -> str:
    digest = hashlib.sha512()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def prefetch_firefox(ctx: Context) -> Dict[str, Any]:
    config = read_json(ctx.root / "surfer.json")
    version = config.get("version", {}).get("version", "")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}(?:[ab][0-9]+|esr)?", version):
        raise DevError("Unsupported Firefox release version in surfer.json")
    filename = "firefox-%s.source.tar.xz" % version
    base = "https://archive.mozilla.org/pub/firefox/releases/%s/" % version
    with _official_response(base + "SHA512SUMS") as response:
        raw = response.read(10 * 1024 * 1024 + 1)
    if len(raw) > 10 * 1024 * 1024:
        raise DevError("Unexpectedly large Mozilla checksum manifest")
    expected = None
    for line in raw.decode("utf-8").splitlines():
        fields = line.split(None, 1)
        if len(fields) == 2 and fields[1].lstrip(" *") == "source/" + filename:
            if expected is not None or not re.fullmatch(r"[0-9a-fA-F]{128}", fields[0]):
                raise DevError("Ambiguous/invalid source SHA512SUMS entry")
            expected = fields[0].lower()
    if expected is None:
        raise DevError("Official SHA512SUMS has no exact source archive entry")
    cache = ctx.root / ".surfer" / "engine" / filename
    no_symlink_ancestors(cache)
    if cache.is_file() and _sha512(cache) == expected:
        return {"archive": str(cache), "sha512": expected, "cached": True}
    cache.parent.mkdir(parents=True, exist_ok=True)
    pending = cache.with_name(cache.name + ".part-" + uuid.uuid4().hex)
    try:
        digest = hashlib.sha512()
        total = 0
        last_progress = time.monotonic()
        with _official_response(base + "source/" + filename) as response, pending.open("xb") as output:
            declared = response.headers.get("Content-Length")
            length = int(declared) if declared is not None else None
            for block in iter(lambda: response.read(1024 * 1024), b""):
                digest.update(block)
                total += len(block)
                output.write(block)
                if time.monotonic() - last_progress >= 10:
                    print("Firefox source downloaded: %.1f MiB" % (total / 1024 ** 2), flush=True)
                    last_progress = time.monotonic()
            output.flush()
            os.fsync(output.fileno())
        if (length is not None and total != length) or digest.hexdigest() != expected:
            raise DevError("Firefox source download is incomplete or SHA-512 does not match Mozilla")
        os.replace(pending, cache)
    finally:
        pending.unlink(missing_ok=True)
    return {"archive": str(cache), "sha512": expected, "cached": False}
