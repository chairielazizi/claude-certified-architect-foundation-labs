"""D3.5 - The interview pattern: have Claude ask questions before it implements.

In an unfamiliar domain you don't know which questions matter. Telling Claude to interview you first
surfaces them: for a cache, how it gets invalidated, what happens when it is down, and where stale
data is unacceptable. The answers then shape the design. Without the interview Claude writes the
obvious cache, which here never invalidates and would serve a stale price at checkout.

Run:  python interview_pattern.py          (offline: scripted transcript)
      python interview_pattern.py --live   (real Claude; the developer's answers are still scripted)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

TASK = (
    "Add caching to the product pricing service. get_price(sku, currency) hits Postgres on every call and "
    "p95 latency on product pages is 180ms."
)

INTERVIEW_SYSTEM = (
    "You are a senior engineer pairing with a developer who is new to this domain. Before writing any code, "
    "interview them: ask at most 5 numbered questions about considerations they may not have anticipated - "
    "cache invalidation strategy, failure modes, consistency requirements, key design and expiry, and how "
    "success is measured. Ask only questions whose answers would change the design. Do not write code until "
    "they have answered; then summarize the decisions their answers imply and implement."
)
PLAIN_SYSTEM = "You are a senior engineer. Implement what the developer asks."

ANSWERS = (
    "1. Prices change in the admin tool, which publishes a PriceChanged event. A change must be visible within a minute.\n"
    "2. If the cache is down, read from Postgres. A price lookup must never fail because of the cache.\n"
    "3. Checkout must always use the live price. Product pages may be up to a minute stale.\n"
    "4. About 40k SKUs; prices are per currency.\n"
    "5. Success means p95 under 20ms on product pages."
)

# ---------------------------------------------------------------------------
# Offline stand-in for Claude: behaves according to its system prompt and the conversation so far
# ---------------------------------------------------------------------------

QUESTIONS = """Before I write anything, a few questions whose answers change the design:
1. Invalidation: how do prices change (admin tool, batch import, external feed), and how quickly must a change be visible?
2. Failure modes: if the cache is slow or down, should lookups fail, or fall back to Postgres?
3. Consistency: is any path allowed to show a stale price - product pages, cart, checkout?
4. Keys: roughly how many SKUs, and do prices vary by currency, region or customer tier?
5. Success: what latency target are we aiming for, and where is it measured?"""

DESIGN = """Decisions from your answers:
- Invalidation: subscribe to PriceChanged and delete price:{sku}:{currency} (cache-aside); a 60s TTL is the safety net for "visible within a minute".
- Failure mode: cache errors are logged and the lookup falls back to Postgres (fail open), with a 50ms cache timeout so a slow cache cannot add latency.
- Consistency: checkout calls get_live_price() and bypasses the cache; product pages use the cached path.
- Keys: price:{sku}:{currency}; ~40k SKUs x currencies is small enough to keep warm.
- Success: p95 < 20ms on product pages; emit hit/miss/fallback counters to verify it.

```python
def get_price(sku, currency):
    key = f"price:{sku}:{currency}"
    try:
        cached = cache.get(key, timeout_ms=50)
        if cached is not None:
            return cached
    except CacheError:
        metrics.incr("price_cache.fallback")
        return db.fetch_price(sku, currency)
    price = db.fetch_price(sku, currency)
    cache.set(key, price, ttl_s=60)
    return price


def on_price_changed(event):
    cache.delete(f"price:{event.sku}:{event.currency}")


def get_live_price(sku, currency):  # checkout path: never cached
    return db.fetch_price(sku, currency)
```"""

NAIVE = """Here is a cached version:

```python
from functools import lru_cache


@lru_cache(maxsize=50_000)
def get_price(sku, currency):
    return db.fetch_price(sku, currency)
```

Repeat lookups no longer touch the database."""


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    interviewing = "interview" in lab.system_text(params).lower()
    first_turn = len(params["messages"]) == 1
    if interviewing and first_turn:
        return lab.message(lab.text(QUESTIONS))
    if interviewing:
        return lab.message(lab.text(DESIGN))
    return lab.message(lab.text(NAIVE))


def ask(client: Any, system: str, messages: list[dict[str, Any]]) -> Any:
    response = client.messages.create(model=lab.MODEL, max_tokens=16000, system=system, messages=messages)
    messages.append({"role": "assistant", "content": response.content})
    return response


def main() -> None:
    lab.banner("D3.5  Interview pattern: questions first, then implementation")
    client = lab.get_client(scripted_model)

    lab.section("A. Without the interview instruction")
    plain: list[dict[str, Any]] = [{"role": "user", "content": TASK}]
    naive = lab.text_of(ask(client, PLAIN_SYSTEM, plain))
    print("\n".join("  claude> " + line for line in naive.splitlines()))

    lab.section("B. With the interview instruction")
    convo: list[dict[str, Any]] = [{"role": "user", "content": TASK}]
    questions = lab.text_of(ask(client, INTERVIEW_SYSTEM, convo))
    print("\n".join("  claude> " + line for line in questions.splitlines()))
    convo.append({"role": "user", "content": ANSWERS})
    print("\n".join("  dev>    " + line for line in ANSWERS.splitlines()))
    design = lab.text_of(ask(client, INTERVIEW_SYSTEM, convo))
    print("\n".join("  claude> " + line for line in design.splitlines()))

    lab.section("Checks")
    lab.check(len(convo) == 4 and convo[-1]["role"] == "assistant", "interview flow: task -> questions -> answers -> design")
    if not lab.is_live():
        lab.check("```" not in questions and questions.count("?") >= 3, "first reply asks questions and writes no code")
        topics = [w for w in ("invalidat", "down", "stale") if w in questions.lower()]
        lab.check(len(topics) == 3, "the questions cover invalidation, failure modes and consistency")
        lab.check(
            all(s in design for s in ("PriceChanged", "falls back to Postgres", "checkout calls get_live_price()")),
            "the design applies each answer: event invalidation, fail-open fallback, live price at checkout",
        )
        lab.check(
            "```" in naive and "invalidat" not in naive.lower(),
            "without the interview: immediate code that never invalidates (stale prices, even at checkout)",
        )


if __name__ == "__main__":
    main()
