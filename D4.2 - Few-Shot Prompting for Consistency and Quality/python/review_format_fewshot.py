"""D4.2 - Few-shot examples for consistent review output and fewer false positives.

    zero-shot (detailed instructions only) -> format drifts: prose, other keys, "Major"
                                           -> flags anything that looks risky
    few-shot  (3 examples with reasoning)  -> every output in the example's exact format
                                           -> acceptable patterns left alone, judgment
                                              generalizes to snippets no example showed

Run:  python review_format_fewshot.py          (offline, scripted model)
      python review_format_fewshot.py --live   (real Claude API)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from fewshot_prompts import REVIEW_EXAMPLES, build_review_prompt, review_user_message  # noqa: E402
from scoring import conforms, finding_count, format_consistency  # noqa: E402
from scripted_model import SNIPPETS, review_model  # noqa: E402


def run(system: str) -> dict[str, str]:
    client = lab.get_client(review_model)
    outputs = {}
    for snippet in SNIPPETS:
        response = client.messages.create(
            model=lab.MODEL,
            max_tokens=4000,
            system=system,
            messages=[{"role": "user", "content": review_user_message(snippet)}],
        )
        outputs[snippet["id"]] = lab.text_of(response).strip()
    return outputs


def summarize(name: str, outputs: dict[str, str]) -> dict[str, Any]:
    lab.section(name)
    for snippet in SNIPPETS:
        text = outputs[snippet["id"]]
        ok, reason = conforms(text)
        kind = ("novel " if snippet["novel"] else "") + snippet["kind"]
        print(f"  {snippet['id']} {kind:<17} format {'OK ' if ok else 'BAD'} [{reason}]")
        print("     " + text.replace("\n", "\n     ")[:220])
    flagged = {s["id"]: finding_count(outputs[s["id"]]) > 0 for s in SNIPPETS}
    result = {
        "consistency": format_consistency(list(outputs.values())),
        "false_positives": [s["id"] for s in SNIPPETS if s["kind"] == "acceptable" and flagged[s["id"]]],
        "caught": [s["id"] for s in SNIPPETS if s["kind"] == "genuine" and flagged[s["id"]]],
    }
    print(f"  -> format consistency {result['consistency']:.0%}, false positives {result['false_positives']}, caught {result['caught']}")
    return result


def main() -> None:
    lab.banner("D4.2  Few-shot examples: consistent format, fewer false positives")
    few_shot_prompt = build_review_prompt(REVIEW_EXAMPLES)
    print(f"few-shot prompt carries {few_shot_prompt.count('<example ')} examples, each with <reasoning>")

    zero = summarize("zero-shot: detailed instructions only", run(build_review_prompt()))
    few = summarize("few-shot: same instructions + 3 targeted examples", run(few_shot_prompt))

    genuine = [s["id"] for s in SNIPPETS if s["kind"] == "genuine"]
    novel = {s["id"]: s["kind"] for s in SNIPPETS if s["novel"]}
    lab.check(2 <= few_shot_prompt.count("<example ") <= 4, "2-4 targeted examples, not a long catalogue")
    lab.check(few_shot_prompt.count("<reasoning>") == len(REVIEW_EXAMPLES), "every example explains why it was (not) flagged")
    if not lab.is_live():
        lab.check(zero["consistency"] < 0.5, "instructions alone: most outputs break the required format")
        lab.check(few["consistency"] == 1.0, "few-shot: every output has location, issue, severity, suggested_fix")
        lab.check(len(zero["false_positives"]) == 2, "zero-shot flags both acceptable patterns")
        lab.check(not few["false_positives"], "few-shot leaves acceptable patterns alone")
        lab.check(few["caught"] == genuine, "few-shot still catches every genuine issue")
        lab.check(
            "S4" in few["caught"] and "S5" not in few["false_positives"] and set(novel) == {"S4", "S5"},
            "judgment generalized to novel code (mutable default flagged, intentional narrow except accepted)",
        )


if __name__ == "__main__":
    main()
