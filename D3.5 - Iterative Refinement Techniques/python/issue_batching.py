"""D3.5 - One detailed message for interacting issues, sequential messages for independent ones.

Issues INTERACT when their fixes touch the same function or the same data: fixing them one at a time
makes each later fix re-break or redo the earlier one (here: rounding mode, conversion order and
discount timing all decide price_cents). Send those together, in one message that says how they
relate and states every expectation that must hold at once. Independent issues (a log typo, a README
example) go one per message, so each fix is small and verified on its own.

Run:  python issue_batching.py
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402


@dataclass
class Issue:
    id: str
    summary: str
    touches: frozenset[str]  # functions / fields / files the fix has to change
    expected: str  # a concrete input -> output that must hold after the fix


ISSUES = [
    Issue("I1", "normalize_price rounds half-down; amounts must round half-up to whole cents",
          frozenset({"fn:normalize_price", "field:price_cents"}), "normalize_price(10.005, 'USD') -> 1001 cents, not 1000"),
    Issue("I2", "normalize_price rounds BEFORE converting currency; convert first, then round once",
          frozenset({"fn:normalize_price", "field:price_cents"}), "normalize_price(9.99, 'EUR') at rate 1.0832 -> 1082 cents"),
    Issue("I3", "apply_discount subtracts the coupon before tax; the spec applies coupons after tax",
          frozenset({"fn:apply_discount", "field:price_cents"}), "100.00 + 20% tax - 5.00 coupon -> 11500 cents, not 11400"),
    Issue("I4", "log_order message has a typo ('recieved')", frozenset({"fn:log_order"}), "log line reads 'Order received: ord_1'"),
    Issue("I5", "README example still passes the removed --legacy-pricing flag", frozenset({"file:README.md"}), "the README example runs on the current CLI"),
]


def group_interacting(issues: list[Issue]) -> list[list[Issue]]:
    """Union issues that share any function, field or file; each group is fixed in one message."""
    parent = {issue.id: issue.id for issue in issues}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for i, a in enumerate(issues):
        for b in issues[i + 1 :]:
            if a.touches & b.touches:
                parent[find(b.id)] = find(a.id)
    groups: dict[str, list[Issue]] = {}
    for issue in issues:
        groups.setdefault(find(issue.id), []).append(issue)
    return list(groups.values())


def plan_messages(issues: list[Issue]) -> list[tuple[str, list[str], str]]:
    """(kind, issue ids, message text): interacting groups first, then independent issues one by one."""
    groups = group_interacting(issues)
    combined = [g for g in groups if len(g) > 1]
    singles = [g[0] for g in groups if len(g) == 1]
    messages = []
    for group in combined:
        shared = sorted(set.intersection(*(set(i.touches) for i in group)) or set.union(*(set(i.touches) for i in group)))
        lines = [
            f"These {len(group)} issues interact - they all change {', '.join(s.split(':', 1)[1] for s in shared)}. "
            "Fix them together in one change so each fix accounts for the others; fixing them one at a time "
            "would make every later fix redo or break the earlier ones.",
            "",
        ]
        lines += [f"{n}. [{i.id}] {i.summary}\n   expected: {i.expected}" for n, i in enumerate(group, 1)]
        lines += ["", "After your change, ALL of the expectations above must hold at the same time. Add a test for each."]
        messages.append(("combined", [i.id for i in group], "\n".join(lines)))
    for issue in singles:
        text = f"Fix one independent issue (nothing else depends on it): [{issue.id}] {issue.summary}\nexpected: {issue.expected}"
        messages.append(("single", [issue.id], text))
    return messages


def main() -> None:
    lab.banner("D3.5  Interacting issues in one message, independent issues one at a time")
    groups = group_interacting(ISSUES)
    lab.section("Grouping by shared functions / fields / files")
    for group in groups:
        touched = sorted(set().union(*(i.touches for i in group)))
        print(f"  {'+'.join(i.id for i in group):<10} {'interacting' if len(group) > 1 else 'independent':<12} touches {touched}")

    lab.section("Messages to send, in order")
    messages = plan_messages(ISSUES)
    for n, (kind, ids, text) in enumerate(messages, 1):
        print(f"\n  message {n} ({kind}, {', '.join(ids)}):")
        print("\n".join("    | " + line for line in text.splitlines()))

    lab.section("Checks")
    kinds = [(kind, ids) for kind, ids, _ in messages]
    lab.check(kinds[0] == ("combined", ["I1", "I2", "I3"]), "I1, I2 and I3 go in ONE detailed message")
    lab.check(
        "I3" in kinds[0][1] and "fn:normalize_price" not in ISSUES[2].touches,
        "I3 is in a different function but joins the group through the shared price_cents field",
    )
    lab.check(kinds[1:] == [("single", ["I4"]), ("single", ["I5"])], "the log typo and the README fix go one at a time")
    combined_text = messages[0][2]
    lab.check(all(i.expected in combined_text for i in ISSUES[:3]), "the combined message states every expectation that must hold together")


if __name__ == "__main__":
    main()
