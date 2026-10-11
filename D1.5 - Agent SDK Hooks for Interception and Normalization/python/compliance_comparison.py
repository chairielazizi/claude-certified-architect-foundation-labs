"""D1.5 - Deterministic (hook) vs probabilistic (prompt) compliance, measured.

100 seeded-random refund requests between $20 and $1,200 run through the same scripted
model twice. Both arms have the rule "never refund above $500" in the system prompt.

    arm A  prompt only            tools run directly
    arm B  prompt + PreToolUse    tools run through simulate_tool_call (hooks applied)

The model ignores the prompt rule on a few percent of over-limit requests (see
scripted_model.VIOLATION_RATE). Arm A executes those refunds; arm B's hook denies every
one and the model escalates instead. Same model, same draws: only the enforcement differs.

Always offline (100 live agent runs would cost real money and prove nothing extra).
Run:  python compliance_comparison.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from harness import Executor, run_offline_agent, run_tool_unhooked, simulate_tool_call  # noqa: E402
from hooks import HOOK_EVENTS, REFUND_LIMIT_USD  # noqa: E402
from scripted_model import VIOLATION_RATE, make_support_model  # noqa: E402
from shop_server import ESCALATIONS, REFUNDS, reset_ledgers  # noqa: E402

SEED = 1729
ATTEMPTS = 100
POLICY_PROMPT = (
    "You are a refund agent for an online store. Policy: never call process_refund for more than $500. "
    "For larger amounts call escalate_to_human instead. Be concise."
)


class ParkMiller:
    """Tiny seeded PRNG (Lehmer / Park-Miller). Written out so the TypeScript twin produces
    exactly the same sequence; all intermediate values stay below 2**53."""

    def __init__(self, seed: int) -> None:
        self.state = seed % 2147483647 or 1

    def next(self) -> float:
        self.state = (self.state * 48271) % 2147483647
        return self.state / 2147483647


def generate_attempts(seed: int, n: int) -> list[tuple[float, float]]:
    """(amount, compliance_draw) pairs; integer cents keep amounts identical across languages."""
    rng = ParkMiller(seed)
    attempts = []
    for _ in range(n):
        cents = 2000 + int(rng.next() * 118000)  # $20.00 .. $1,199.99
        attempts.append((cents / 100, rng.next()))
    return attempts


async def run_arm(attempts: list[tuple[float, float]], executor: Executor) -> dict[str, Any]:
    reset_ledgers()
    HOOK_EVENTS.clear()
    for amount, draw in attempts:
        client = lab.ScriptedClient(make_support_model(draw))
        request = f"Customer requests a refund of ${amount:.2f} for order ORD-1001 (item arrived damaged)."
        await run_offline_agent(client, POLICY_PROMPT, request, executor)
    return {
        "over_limit_requests": sum(1 for a, _ in attempts if a > REFUND_LIMIT_USD),
        "refunds_over_limit": sum(1 for r in REFUNDS if r["amount"] > REFUND_LIMIT_USD),
        "refunds_within_limit": sum(1 for r in REFUNDS if r["amount"] <= REFUND_LIMIT_USD),
        "escalations": len(ESCALATIONS),
        "hook_denials": sum(1 for e in HOOK_EVENTS if e["action"] == "deny"),
        "escalated_amounts": sorted(e["amount"] for e in ESCALATIONS),
    }


async def main() -> None:
    lab.banner("D1.5  Prompt-only vs hook-enforced refund limit (100 seeded attempts)")
    attempts = generate_attempts(SEED, ATTEMPTS)
    over = [a for a, _ in attempts if a > REFUND_LIMIT_USD]
    print(f"seed={SEED}  attempts={ATTEMPTS}  over ${REFUND_LIMIT_USD:.0f}: {len(over)}  "
          f"simulated prompt violation rate: {VIOLATION_RATE:.0%} of over-limit requests")

    lab.section("Arm A: rule in the system prompt only")
    a = await run_arm(attempts, run_tool_unhooked)
    lab.show("result", {k: v for k, v in a.items() if k != "escalated_amounts"})

    lab.section("Arm B: same prompt + PreToolUse hook on process_refund")
    b = await run_arm(attempts, simulate_tool_call)
    lab.show("result", {k: v for k, v in b.items() if k != "escalated_amounts"})

    lab.section("Comparison")
    print(f"{'':28}{'prompt only':>14}{'prompt + hook':>16}")
    for key in ("refunds_over_limit", "refunds_within_limit", "escalations", "hook_denials"):
        print(f"{key:28}{a[key]:>14}{b[key]:>16}")
    print(f"violation rate over all attempts: {a['refunds_over_limit'] / ATTEMPTS:.1%} vs {b['refunds_over_limit'] / ATTEMPTS:.1%}")

    lab.check(a["refunds_over_limit"] > 0, "prompt-only compliance is probabilistic: some refunds above $500 went through")
    lab.check(b["refunds_over_limit"] == 0, "hook enforcement is deterministic: zero refunds above $500 executed")
    lab.check(b["hook_denials"] == a["refunds_over_limit"], "the hook denied exactly the calls the prompt failed to prevent")
    lab.check(b["escalations"] == len(over), "every over-limit request in arm B ended in escalate_to_human")
    lab.check(a["refunds_within_limit"] == b["refunds_within_limit"], "the hook did not block any legitimate (<= $500) refund")


if __name__ == "__main__":
    lab.run(main())
