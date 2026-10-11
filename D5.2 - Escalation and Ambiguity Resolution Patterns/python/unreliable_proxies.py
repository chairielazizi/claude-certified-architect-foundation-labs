"""D5.2 - Sentiment and self-reported confidence are unreliable proxies for "needs a human".

Every labelled case carries a logged sentiment score and the agent's self-reported
confidence. Three escalation policies are scored against the reviewers' labels:

    sentiment rule      escalate when sentiment < -0.5         (sample Q3, option D)
    confidence rule     escalate when self_confidence < 6      (sample Q3, option B)
    explicit criteria   what the criteria-prompted agent actually did (escalate_to_human or not)

Furious customers with covered problems do not need a human; polite customers asking for
something the policy does not cover do. And the agent is most confident exactly where it
is about to improvise policy.

Run:  python unreliable_proxies.py          (offline)
      python unreliable_proxies.py --live   (criteria decisions from the real API)
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from support_agent import CRITERIA_PROMPT, load_fixture, pct, run_conversation, scripted_model  # noqa: E402

CASES = load_fixture("cases.json")["cases"]
SENTIMENT_THRESHOLD = -0.5
CONFIDENCE_THRESHOLD = 6


def score(predicted: list[bool], labels: list[bool]) -> dict[str, int]:
    return {
        "agree": sum(1 for p, y in zip(predicted, labels) if p == y),
        "missed": sum(1 for p, y in zip(predicted, labels) if y and not p),
        "unnecessary": sum(1 for p, y in zip(predicted, labels) if p and not y),
    }


def yn(flag: bool) -> str:
    return "ESC" if flag else "-"


def main() -> None:
    lab.banner("D5.2  Why sentiment and self-reported confidence are unreliable escalation proxies")
    labels = [c["expected"] == "escalate" for c in CASES]
    by_sentiment = [c["sentiment"] < SENTIMENT_THRESHOLD for c in CASES]
    by_confidence = [c["self_confidence"] < CONFIDENCE_THRESHOLD for c in CASES]
    by_criteria = [
        run_conversation(lab.get_client(scripted_model), CRITERIA_PROMPT, [c["message"]], verbose=False)["outcome"] == "escalate"
        for c in CASES
    ]

    lab.section("Per case (label = reviewer says a human is needed)")
    print(f"  {'case':5}{'sentiment':>10}{'confidence':>11}  {'label':6}{'sent.':6}{'conf.':6}{'criteria':8}  reason")
    for c, y, s, k, e in zip(CASES, labels, by_sentiment, by_confidence, by_criteria):
        sentiment = f"{c['sentiment']:+.1f}"
        print(f"  {c['id']:5}{sentiment:>10}{c['self_confidence']:>11}  {yn(y):6}{yn(s):6}{yn(k):6}{yn(e):8}  {c['reason'] or ''}")

    lab.section("Agreement with the labels")
    n = len(CASES)
    scores = {
        f"sentiment < {SENTIMENT_THRESHOLD}": score(by_sentiment, labels),
        f"self_confidence < {CONFIDENCE_THRESHOLD}": score(by_confidence, labels),
        "explicit criteria": score(by_criteria, labels),
    }
    print(f"  {'rule':24}{'agreement':>12}{'missed':>8}{'unneeded':>10}")
    for rule, s in scores.items():
        print(f"  {rule:24}{pct(s['agree'], n):>12}{s['missed']:>8}{s['unnecessary']:>10}")

    sent, conf, crit = scores[f"sentiment < {SENTIMENT_THRESHOLD}"], scores[f"self_confidence < {CONFIDENCE_THRESHOLD}"], scores["explicit criteria"]
    confident_but_needs_human = [c["id"] for c, y in zip(CASES, labels) if y and c["self_confidence"] >= 8]
    print(f"  cases needing a human where the agent rated itself >= 8/10: {confident_but_needs_human}")

    lab.section("Checks")
    lab.check(sent["agree"] * 2 < n and conf["agree"] * 2 < n, "both proxies agree with the labels on fewer than half the cases")
    lab.check(sent["unnecessary"] >= 2 and sent["missed"] >= 4, "sentiment escalates furious-but-covered cases and misses calm policy requests")
    lab.check(len(confident_but_needs_human) >= 4, "self-reported confidence is highest on cases that need a human (it is not calibrated)")
    if not lab.is_live():
        lab.check(crit["agree"] == n, "explicit criteria matched every label: escalate on the actual reasons, not on proxies")


if __name__ == "__main__":
    main()
