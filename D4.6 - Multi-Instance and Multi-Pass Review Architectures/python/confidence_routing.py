"""D4.6 - Self-reported confidence per finding -> calibrated routing + a verification pass.

    confidence >= 0.8          -> auto-post as a PR comment
    confidence <  0.8          -> verification pass: an independent instance re-checks ONLY that
                                  finding against the code (fresh context, no reviewer reasoning)
        confirmed (>= 0.8)     -> auto-post
        rejected               -> drop (logged, never shown to the developer)
        uncertain              -> human triage queue

Run:  python confidence_routing.py          (offline, scripted reviewer)
      python confidence_routing.py --live   (real Claude API)
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from multi_pass_review import run_multi_pass  # noqa: E402
from review_engine import VERIFY_PROMPT, Finding, files_message, load_pr, scripted_reviewer  # noqa: E402

AUTO_POST_THRESHOLD = 0.8


def verify_finding(client: Any, finding: Finding, files: dict[str, str]) -> dict[str, Any]:
    content = f"<finding>\n{finding.model_dump_json()}\n</finding>\n{files_message(files)}"
    response = client.messages.create(
        model=lab.MODEL, max_tokens=4000, system=VERIFY_PROMPT, messages=[{"role": "user", "content": content}]
    )
    text = lab.text_of(response)
    return json.loads(text[text.find("{") : text.rfind("}") + 1])


def main() -> None:
    lab.banner("D4.6  Confidence-based routing with a verification pass")
    files = load_pr()
    client = lab.get_client(scripted_reviewer)
    local, integration = run_multi_pass(client, files)
    findings = local + integration

    lab.section("1. Route by self-reported confidence")
    auto_post = [f for f in findings if f.confidence >= AUTO_POST_THRESHOLD]
    to_verify = [f for f in findings if f.confidence < AUTO_POST_THRESHOLD]
    print(f"  {len(findings)} findings: {len(auto_post)} at >= {AUTO_POST_THRESHOLD} -> auto-post, {len(to_verify)} -> verification pass")

    lab.section("2. Verification pass on the low-confidence findings")
    verifier = lab.get_client(scripted_reviewer)  # separate instance: no reviewer history
    dropped: list[Finding] = []
    human: list[tuple[Finding, dict[str, Any]]] = []
    verified = 0
    for f in to_verify:
        result = verify_finding(verifier, f, files)
        verified += 1
        print(f"  {f.file}:{f.line} {f.detected_pattern} (conf {f.confidence:.2f}) -> {result['verdict']} ({result['confidence']:.2f}): {result['evidence']}")
        if result["verdict"] == "confirmed" and result["confidence"] >= AUTO_POST_THRESHOLD:
            auto_post.append(f.model_copy(update={"confidence": result["confidence"]}))
        elif result["verdict"] == "rejected":
            dropped.append(f)
        else:
            human.append((f, result))

    lab.section("3. Outcome")
    print(f"  auto-posted : {len(auto_post)}  {sorted({f.detected_pattern for f in auto_post})}")
    print(f"  human triage: {len(human)}  {[f.detected_pattern for f, _ in human]}")
    print(f"  dropped     : {len(dropped)}  {[f.detected_pattern for f in dropped]}")

    lab.check(all(f.confidence >= AUTO_POST_THRESHOLD for f in auto_post), "nothing below the threshold is auto-posted")
    lab.check(verified == len(to_verify), "every low-confidence finding went through a verification pass")
    if not lab.is_live():
        calls = verifier.messages.calls
        lab.check(
            all(len(c["messages"]) == 1 and c["system"] == VERIFY_PROMPT for c in calls),
            "each verification is a fresh, single-message request (no reviewer reasoning carried over)",
        )
        lab.check(any(f.detected_pattern == "unbounded-module-list" for f in auto_post), "a 0.60 finding was confirmed by verification and posted")
        lab.check([f.detected_pattern for f in dropped] == ["unenforced-int-annotation"], "a 0.40 finding was rejected and never reached the developer")
        lab.check([f.detected_pattern for f, _ in human] == ["int-parse-valueerror"], "only the genuinely undecidable one goes to a human")


if __name__ == "__main__":
    main()
