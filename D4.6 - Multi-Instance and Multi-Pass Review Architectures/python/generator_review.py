"""D4.6 - Self-review in the same session vs an independent reviewer instance.

    generator turn          -> code + its own design reasoning (contains a subtle bug)
    self-review, same chat  -> the reasoning is still in context: "consistent with my design"
    "think very carefully"  -> same context, same blind spot
    independent reviewer    -> fresh messages: ONLY the spec and the code -> catches the bug

Run:  python generator_review.py          (offline, scripted model)
      python generator_review.py --live   (real Claude API)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from generator_model import GENERATOR_SYSTEM, REVIEWER_SYSTEM, SELF_REVIEW, SELF_REVIEW_HARDER, TASK, scripted_model  # noqa: E402


def findings_of(response: Any) -> list[dict[str, Any]]:
    text = lab.text_of(response)
    return json.loads(text[text.find("{") : text.rfind("}") + 1])["findings"]


def main() -> None:
    lab.banner("D4.6  Self-review vs independent review instance")

    lab.section("1. Generator writes the code")
    generator = lab.get_client(scripted_model)
    gen_request = {"model": lab.MODEL, "max_tokens": 16000, "system": GENERATOR_SYSTEM, "messages": [{"role": "user", "content": TASK}]}
    generated = generator.messages.create(**gen_request)
    generated_text = lab.text_of(generated)
    block = re.search(r"```python\n(.*?)```", generated_text, flags=re.DOTALL)
    code = block[1] if block else generated_text
    print("  " + generated_text.replace("\n", "\n  "))
    history = [*gen_request["messages"], {"role": "assistant", "content": generated.content}]

    lab.section("2. Self-review in the same conversation")
    self_reviews = {}
    for label, ask in (("review", SELF_REVIEW), ("think very carefully", SELF_REVIEW_HARDER)):
        request = {**gen_request, "messages": [*history, {"role": "user", "content": ask}]}
        self_reviews[label] = (request, findings_of(generator.messages.create(**request)))
        print(f"  self-review ({label}): {self_reviews[label][1] or 'no issues found'}")

    lab.section("3. Independent reviewer: a new instance with only the spec and the code")
    reviewer = lab.get_client(scripted_model)  # separate client/session; nothing shared
    review_request = {
        "model": lab.MODEL,
        "max_tokens": 16000,
        "system": REVIEWER_SYSTEM,
        "messages": [{"role": "user", "content": f"<spec>\n{TASK}\n</spec>\n<code>\n{code.strip()}\n</code>"}],
    }
    independent = findings_of(reviewer.messages.create(**review_request))
    for f in independent:
        print(f"  [{f['severity']}, conf {f['confidence']}] {f['issue']}")

    self_request = self_reviews["review"][0]
    reasoning = generated_text.split("```")[0].strip()  # the generator's explanation, outside the code block
    lab.check(
        self_request["messages"][1]["role"] == "assistant" and self_request["messages"][1]["content"] is generated.content,
        "the self-review request carries the generator's own reasoning",
    )
    lab.check(
        len(review_request["messages"]) == 1
        and review_request["messages"][0]["role"] == "user"
        and reasoning[:80] not in review_request["messages"][0]["content"]
        and review_request["system"] != GENERATOR_SYSTEM,
        "the independent request has no generator history: one user message with spec + code",
    )
    if not lab.is_live():
        lab.check(all(not f for _, f in self_reviews.values()), "self-review missed the bug, even when told to question every assumption")
        lab.check(any("Off-by-one" in f["issue"] for f in independent), "the independent reviewer caught the off-by-one")
        namespace: dict[str, Any] = {}
        exec(code, namespace)  # offline only: this is our own scripted code, never model output
        actual = namespace["paginate"](list(range(10)), 1, 3)
        print(f"  proof: paginate(range(10), page=1, page_size=3) -> {actual} (spec says [0, 1, 2])")
        lab.check(actual != [0, 1, 2], "the bug is real: page 1 skips the first three items")


if __name__ == "__main__":
    main()
