"""Shared helpers used by every Python lab in this repo.

Every lab runs in one of two modes:

* **offline** (default) - a ``ScriptedClient`` stands in for ``anthropic.Anthropic()``
  and replays deterministic, hand-written model turns. You can step through the
  *architecture pattern* with no API key and no cost.
* **live** - pass ``--live`` (or set ``LAB_LIVE=1``) and the lab calls the real
  Claude API through the official ``anthropic`` SDK. Credentials resolve the usual
  way (``ANTHROPIC_API_KEY``, ``ANTHROPIC_AUTH_TOKEN`` or an ``ant auth login`` profile).

Scripted responses are built from ``Obj`` - a dict that also supports attribute
access - so lab code reads ``response.stop_reason`` / ``block.input`` identically in
both modes, and scripted data stays JSON-serialisable for printing.

Import it from a lab with::

    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
    import labkit
"""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import sys
import time
from typing import Any, Awaitable, Callable, Iterable

# Windows consoles default to cp1252 when output is piped; keep demo output printable.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Default model for live runs.
MODEL = os.environ.get("LAB_MODEL", "claude-opus-5-5")

# claude-opus-5-5, claude-sonnet-5-5 and claude-fable-5-1 reject forced tool use
# (tool_choice {"type": "any"} / {"type": "tool", ...}) with HTTP 400. The exam still
# tests those options, so labs that demonstrate them use a model that accepts them.
FORCED_TOOL_CHOICE_MODEL = os.environ.get("LAB_FORCED_TOOL_MODEL", "claude-opus-5")


def is_live() -> bool:
    """True when the lab should call the real Claude API."""
    return "--live" in sys.argv or os.environ.get("LAB_LIVE") == "1"


# ---------------------------------------------------------------------------
# Scripted (offline) responses
# ---------------------------------------------------------------------------


class Obj(dict):
    """A dict that also allows attribute access (``obj.type`` == ``obj["type"]``)."""

    def __getattr__(self, name: str) -> Any:
        try:
            return self[name]
        except KeyError as exc:
            raise AttributeError(name) from exc

    def __setattr__(self, name: str, value: Any) -> None:
        self[name] = value


_ids = itertools.count(1)


def text(value: str) -> Obj:
    """A scripted ``text`` content block."""
    return Obj(type="text", text=value)


def tool_use(name: str, input: dict[str, Any], id: str | None = None) -> Obj:
    """A scripted ``tool_use`` content block."""
    return Obj(type="tool_use", id=id or f"toolu_{next(_ids):04d}", name=name, input=input)


def message(*content: Obj, stop_reason: str | None = None) -> Obj:
    """A scripted assistant ``Message``.

    ``stop_reason`` defaults the way the real API behaves: ``"tool_use"`` when the
    turn contains a tool_use block, otherwise ``"end_turn"``.
    """
    if stop_reason is None:
        stop_reason = "tool_use" if any(b.type == "tool_use" for b in content) else "end_turn"
    return Obj(
        id=f"msg_{next(_ids):04d}",
        type="message",
        role="assistant",
        model="scripted-offline",
        content=list(content),
        stop_reason=stop_reason,
        usage=Obj(input_tokens=0, output_tokens=0),
    )


Responder = Callable[[dict[str, Any]], Obj]


class _ScriptedMessages:
    def __init__(self, responder: Responder, latency_s: float) -> None:
        self._responder = responder
        self._latency_s = latency_s
        self.calls: list[dict[str, Any]] = []

    def create(self, **params: Any) -> Obj:
        self.calls.append(params)
        if self._latency_s:
            time.sleep(self._latency_s)
        return self._responder(params)


class ScriptedClient:
    """Offline stand-in for ``anthropic.Anthropic()``: ``client.messages.create(**params)``."""

    def __init__(self, responder: Responder, latency_s: float = 0.0) -> None:
        self.messages = _ScriptedMessages(responder, latency_s)


class _AsyncScriptedMessages(_ScriptedMessages):
    async def create(self, **params: Any) -> Obj:  # type: ignore[override]
        self.calls.append(params)
        if self._latency_s:
            await asyncio.sleep(self._latency_s)  # simulate network + generation time
        return self._responder(params)


class AsyncScriptedClient:
    """Offline stand-in for ``anthropic.AsyncAnthropic()`` with optional simulated latency."""

    def __init__(self, responder: Responder, latency_s: float = 0.0) -> None:
        self.messages = _AsyncScriptedMessages(responder, latency_s)


def sequence(*turns: Obj) -> Responder:
    """Responder that returns the given turns in order (simplest possible script)."""
    queue = list(turns)

    def respond(_params: dict[str, Any]) -> Obj:
        if not queue:
            raise RuntimeError("Scripted conversation ran out of turns")
        return queue.pop(0)

    return respond


def get_client(responder: Responder | None = None, latency_s: float = 0.0):
    """Real ``anthropic.Anthropic()`` in live mode, otherwise a ``ScriptedClient``."""
    if is_live():
        import anthropic  # imported lazily so offline runs need no packages

        return anthropic.Anthropic()
    if responder is None:
        raise SystemExit("This lab step only runs live. Re-run with --live.")
    return ScriptedClient(responder, latency_s)


def get_async_client(responder: Responder | None = None, latency_s: float = 0.0):
    """Real ``anthropic.AsyncAnthropic()`` in live mode, otherwise an ``AsyncScriptedClient``."""
    if is_live():
        import anthropic

        return anthropic.AsyncAnthropic()
    if responder is None:
        raise SystemExit("This lab step only runs live. Re-run with --live.")
    return AsyncScriptedClient(responder, latency_s)


# ---------------------------------------------------------------------------
# Helpers for reading request params inside responders, and responses in labs
# ---------------------------------------------------------------------------


def system_text(params: dict[str, Any]) -> str:
    """The system prompt of a request as plain text (string or list of text blocks)."""
    system = params.get("system") or ""
    if isinstance(system, str):
        return system
    return "\n".join(block.get("text", "") for block in system)


def _field(block: Any, name: str, default: Any = None) -> Any:
    if isinstance(block, dict):
        return block.get(name, default)
    return getattr(block, name, default)


def last_user_blocks(params: dict[str, Any]) -> list[Any]:
    """Content blocks of the most recent user message (strings become one text block)."""
    for msg in reversed(params.get("messages", [])):
        if msg["role"] == "user":
            content = msg["content"]
            return [Obj(type="text", text=content)] if isinstance(content, str) else list(content)
    return []


def last_user_text(params: dict[str, Any]) -> str:
    return "\n".join(_field(b, "text", "") for b in last_user_blocks(params) if _field(b, "type") == "text")


def tool_results(params: dict[str, Any]) -> list[Any]:
    """tool_result blocks in the most recent user message."""
    return [b for b in last_user_blocks(params) if _field(b, "type") == "tool_result"]


def all_tool_calls(params: dict[str, Any]) -> list[str]:
    """Names of every tool the assistant has called so far in this conversation."""
    names: list[str] = []
    for msg in params.get("messages", []):
        if msg["role"] == "assistant" and not isinstance(msg["content"], str):
            names += [_field(b, "name") for b in msg["content"] if _field(b, "type") == "tool_use"]
    return names


def text_of(response: Any) -> str:
    """Concatenated text blocks of a response (works for SDK objects and ``Obj``)."""
    return "".join(_field(b, "text", "") for b in response.content if _field(b, "type") == "text")


def tool_uses(response: Any) -> list[Any]:
    return [b for b in response.content if _field(b, "type") == "tool_use"]


def to_plain(value: Any) -> Any:
    """Convert SDK pydantic models / Obj / containers into JSON-friendly data."""
    if hasattr(value, "model_dump"):
        return value.model_dump(exclude_none=True)
    if isinstance(value, dict):
        return {k: to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_plain(v) for v in value]
    return value


# ---------------------------------------------------------------------------
# Console output
# ---------------------------------------------------------------------------


def banner(title: str) -> None:
    line = "=" * max(60, len(title) + 4)
    mode = f"LIVE (model {MODEL})" if is_live() else "OFFLINE (scripted model turns; pass --live for the real API)"
    print(f"{line}\n  {title}\n  mode: {mode}\n{line}")


def section(title: str) -> None:
    print(f"\n--- {title} " + "-" * max(3, 56 - len(title)))


def show(label: str, value: Any) -> None:
    """Pretty-print a labelled value (dicts/lists as indented JSON)."""
    plain = to_plain(value)
    if isinstance(plain, (dict, list)):
        print(f"{label}:\n{json.dumps(plain, indent=2, default=str)}")
    else:
        print(f"{label}: {plain}")


def run(coro: Awaitable[Any]) -> Any:
    """``asyncio.run`` wrapper so labs can stay one-liners at the bottom."""
    return asyncio.run(coro)  # type: ignore[arg-type]


def check(condition: bool, message_: str) -> None:
    """Assert a lab invariant with a readable PASS/FAIL line (non-zero exit on failure)."""
    print(f"  [{'PASS' if condition else 'FAIL'}] {message_}")
    if not condition:
        raise SystemExit(1)


__all__: Iterable[str] = [
    "MODEL",
    "FORCED_TOOL_CHOICE_MODEL",
    "is_live",
    "Obj",
    "text",
    "tool_use",
    "message",
    "ScriptedClient",
    "AsyncScriptedClient",
    "sequence",
    "get_client",
    "get_async_client",
    "system_text",
    "last_user_blocks",
    "last_user_text",
    "tool_results",
    "all_tool_calls",
    "text_of",
    "tool_uses",
    "to_plain",
    "banner",
    "section",
    "show",
    "run",
    "check",
]
