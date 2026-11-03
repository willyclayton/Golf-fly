"""HTTP access with a descriptive User-Agent, retries and an optional disk cache.

Every call to a public service (Overpass, ArcGIS image servers) goes through
here, so politeness rules live in one place: a named client, sequential
requests, exponential backoff, and honouring Retry-After.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from pathlib import Path

import requests

from . import __version__

log = logging.getLogger(__name__)

USER_AGENT = f"golf-fly-pipeline/{__version__} (+https://github.com/willyclayton/golf-fly)"
RETRY_STATUS = {408, 429, 500, 502, 503, 504}


class HttpError(RuntimeError):
    """A request failed for good (non-retryable status, or retries exhausted)."""


class RetryableResponse(RuntimeError):
    """Raised by a validator when a 200 response is really a transient failure."""


Validator = Callable[[bytes, str], None]


class Http:
    def __init__(
        self,
        cache_dir: Path | str | None = None,
        *,
        retries: int = 4,
        backoff_s: float = 2.0,
        timeout_s: float = 180.0,
        min_interval_s: float = 1.0,
    ) -> None:
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.cache_dir = Path(cache_dir) if cache_dir else None
        self.retries = retries
        self.backoff_s = backoff_s
        self.timeout_s = timeout_s
        self.min_interval_s = min_interval_s
        self._last_request = 0.0
        self.requests_made = 0
        self.cache_hits = 0

    def _cache_path(self, method: str, url: str, params, data) -> Path | None:
        if not self.cache_dir:
            return None
        blob = json.dumps([method, url, params, data], sort_keys=True, default=str)
        key = hashlib.sha256(blob.encode()).hexdigest()
        return self.cache_dir / key[:2] / key

    def fetch(
        self,
        method: str,
        url: str,
        *,
        params: dict | None = None,
        data: dict | None = None,
        validate: Validator | None = None,
        cache: bool = True,
        timeout_s: float | None = None,
    ) -> tuple[bytes, str]:
        """Return (body, content_type) for a successful request."""
        path = self._cache_path(method, url, params, data) if cache else None
        if path and path.exists():
            meta = json.loads(path.with_suffix(".meta").read_text())
            self.cache_hits += 1
            return path.read_bytes(), meta.get("content_type", "")

        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            wait = self.min_interval_s - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            retry_after = None
            try:
                self._last_request = time.monotonic()
                self.requests_made += 1
                resp = self.session.request(
                    method, url, params=params, data=data, timeout=timeout_s or self.timeout_s
                )
            except requests.RequestException as exc:
                last_error = exc
            else:
                body = resp.content
                ctype = resp.headers.get("Content-Type", "")
                if resp.status_code == 200:
                    try:
                        if validate:
                            validate(body, ctype)
                    except RetryableResponse as exc:
                        last_error = exc
                    else:
                        if path:
                            path.parent.mkdir(parents=True, exist_ok=True)
                            path.write_bytes(body)
                            path.with_suffix(".meta").write_text(json.dumps({"url": url, "content_type": ctype}))
                        return body, ctype
                elif resp.status_code in RETRY_STATUS:
                    last_error = HttpError(f"HTTP {resp.status_code}: {resp.text[:300]}")
                    retry_after = _retry_after(resp)
                else:
                    raise HttpError(f"{method} {url} -> HTTP {resp.status_code}: {resp.text[:500]}")
            if attempt < self.retries:
                delay = retry_after if retry_after is not None else self.backoff_s * (2**attempt)
                log.warning("%s %s failed (%s); retrying in %.0f s", method, url, last_error, delay)
                time.sleep(delay)
        raise HttpError(f"{method} {url} failed after {self.retries + 1} attempts: {last_error}")

    def get_json(self, url: str, params: dict | None = None, **kw) -> dict:
        body, _ = self.fetch("GET", url, params=params, validate=_json_validator, **kw)
        return json.loads(body)


def _retry_after(resp: requests.Response) -> float | None:
    value = resp.headers.get("Retry-After")
    if not value:
        return None
    try:
        return min(float(value), 120.0)
    except ValueError:
        return None


def _json_validator(body: bytes, ctype: str) -> None:
    if not body.lstrip().startswith((b"{", b"[")):
        raise RetryableResponse(f"expected JSON, got {body[:120]!r}")
