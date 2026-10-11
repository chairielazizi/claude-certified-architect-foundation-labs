"""Offline stand-in for client.messages.batches (D4.5), on a simulated clock.

Same surface as the SDK: create(requests=[{custom_id, params}]) -> batch with .id and
.processing_status; retrieve(id) -> "in_progress" until the simulated processing time has
passed, then "ended"; results(id) -> one entry per request with .custom_id and .result.type
in succeeded | errored | expired.

What it simulates, all from a seeded PRNG so every run is identical:
  * results come back in SHUFFLED order (the real API makes no ordering promise)
  * requests over the context limit error with invalid_request_error
  * a chosen number of requests expire (the real API expires what is unfinished at 24h)
  * processing takes 0.5-3.5 simulated hours per batch (real: usually < 1h, max 24h)
"""

from __future__ import annotations

import itertools
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

# Scaled down from the real 1M-token window so the oversized document stays a small fixture.
FAKE_CONTEXT_LIMIT_TOKENS = 6_000


class Mulberry32:
    """Tiny seeded PRNG with an identical TypeScript implementation, so both labs match."""

    def __init__(self, seed: int) -> None:
        self.state = seed & 0xFFFFFFFF

    def random(self) -> float:
        self.state = (self.state + 0x6D2B79F5) & 0xFFFFFFFF
        t = self.state
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    def shuffle(self, items: list[Any]) -> list[Any]:
        out = list(items)
        for i in range(len(out) - 1, 0, -1):
            j = int(self.random() * (i + 1))
            out[i], out[j] = out[j], out[i]
        return out


class SimClock:
    def __init__(self) -> None:
        self.hours = 0.0

    def advance(self, hours: float) -> None:
        self.hours += hours


def approx_tokens(params: dict[str, Any]) -> int:
    text = "".join(m["content"] if isinstance(m["content"], str) else "" for m in params["messages"])
    return (len(text) + len(str(params.get("system", "")))) // 4


class FakeBatchService:
    def __init__(
        self,
        responder: Callable[[dict[str, Any]], Any],
        clock: SimClock,
        seed: int = 7,
        expirations_per_batch: list[int] | None = None,
    ) -> None:
        self._responder = responder
        self._clock = clock
        self._rng = Mulberry32(seed)
        self._expirations = list(expirations_per_batch or [])
        self._batches: dict[str, dict[str, Any]] = {}
        self._ids = itertools.count(1)
        self.created: list[list[str]] = []  # custom_ids per create(), for inspection

    def create(self, requests: list[dict[str, Any]]) -> lab.Obj:
        ids = [r["custom_id"] for r in requests]
        if len(set(ids)) != len(ids):
            raise ValueError("custom_id values must be unique within a batch")
        batch_id = f"msgbatch_fake_{next(self._ids):03d}"
        hours = 0.5 + self._rng.random() * 3.0
        fits = [r["custom_id"] for r in requests if approx_tokens(r["params"]) <= FAKE_CONTEXT_LIMIT_TOKENS]
        expire_n = self._expirations.pop(0) if self._expirations else 0
        expired = set(self._rng.shuffle(fits)[:expire_n])
        self._batches[batch_id] = {
            "requests": requests,
            "created_at": self._clock.hours,
            "ends_at": self._clock.hours + hours,
            "expired": expired,
            "results": None,
        }
        self.created.append(ids)
        return self.retrieve(batch_id)

    def retrieve(self, batch_id: str) -> lab.Obj:
        b = self._batches[batch_id]
        ended = self._clock.hours >= b["ends_at"]
        counts = lab.Obj(processing=len(b["requests"]), succeeded=0, errored=0, canceled=0, expired=0)
        if ended:
            for r in self._results(batch_id):
                counts[r.result.type] += 1
            counts.processing = 0
        return lab.Obj(
            id=batch_id,
            type="message_batch",
            processing_status="ended" if ended else "in_progress",
            request_counts=counts,
            created_at=b["created_at"],
            ended_at=b["ends_at"] if ended else None,
        )

    def results(self, batch_id: str) -> list[lab.Obj]:
        if self.retrieve(batch_id).processing_status != "ended":
            raise RuntimeError("results are only available once processing_status == 'ended'")
        return self._results(batch_id)

    def _results(self, batch_id: str) -> list[lab.Obj]:
        b = self._batches[batch_id]
        if b["results"] is None:
            out = []
            for req in b["requests"]:
                tokens = approx_tokens(req["params"])
                if tokens > FAKE_CONTEXT_LIMIT_TOKENS:
                    error = lab.Obj(type="invalid_request_error", message=f"prompt is too long: {tokens} tokens > {FAKE_CONTEXT_LIMIT_TOKENS} maximum")
                    result = lab.Obj(type="errored", error=lab.Obj(type="error", error=error))
                elif req["custom_id"] in b["expired"]:
                    result = lab.Obj(type="expired")
                else:
                    result = lab.Obj(type="succeeded", message=self._responder(req["params"]))
                out.append(lab.Obj(custom_id=req["custom_id"], result=result))
            b["results"] = self._rng.shuffle(out)  # no ordering guarantee: correlate by custom_id
        return b["results"]
