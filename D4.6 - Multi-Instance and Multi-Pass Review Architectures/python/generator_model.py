"""Prompts and the offline model for D4.6's generator / self-review / independent-review demo.

The generator writes paginate() with a subtle off-by-one (pages are 1-based, the code treats
them as 0-based) and explains its design in the same turn. The offline model then behaves the
way the exam describes:
  * reviewing in the SAME conversation, it reads the code through its own design notes
    ("page maps directly to an offset") and finds the code consistent with them - even when
    told to "think very carefully and question every assumption"
  * as an INDEPENDENT reviewer with only the spec and the code, it checks the code against
    the spec ("1-based") and catches the bug
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

TASK = (
    "Write a Python function paginate(items, page, page_size) for our REST API. Pages are 1-based: "
    "page=1 returns the first page_size items. Pages past the end return []."
)
GENERATOR_SYSTEM = "You are a senior Python developer. Explain your design briefly, then give the code in a ```python block."
REVIEW_FORMAT = 'Respond with JSON only: {"findings": [{"issue": str, "severity": "low|medium|high", "confidence": 0-1}]}.'
SELF_REVIEW = f"Now review the code you just wrote for bugs. {REVIEW_FORMAT}"
SELF_REVIEW_HARDER = f"Review it again. Think very carefully and question every assumption you made. {REVIEW_FORMAT}"
REVIEWER_SYSTEM = f"You are a code reviewer. Check the code strictly against the specification. {REVIEW_FORMAT}"

GENERATED = """Design notes: the page number maps directly to an offset, so the slice starts at
page * page_size and is page_size long. Slicing past the end of a list returns [] in Python,
which covers the out-of-range case without a branch.

```python
def paginate(items, page, page_size):
    start = page * page_size
    return items[start:start + page_size]
```"""


def _content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    return "".join((b.get("text", "") if isinstance(b, dict) else getattr(b, "text", "")) or "" for b in content)


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    messages = params["messages"]
    own_reasoning = any(m["role"] == "assistant" and "Design notes" in _content_text(m["content"]) for m in messages)

    if len(messages) == 1 and lab.system_text(params) == GENERATOR_SYSTEM:
        return lab.message(lab.text(GENERATED))

    if own_reasoning:
        # Same session: the code is judged against the model's own stated design, which it matches.
        return lab.message(
            lab.text(json.dumps({"findings": [], "summary": "Checked against the design: page maps to the offset and slicing past the end returns []. No issues."}))
        )

    user = lab.last_user_text(params)
    spec = re.search(r"<spec>\n(.*?)\n</spec>", user, flags=re.DOTALL)
    code = re.search(r"<code>\n(.*?)\n</code>", user, flags=re.DOTALL)
    findings = []
    if spec and code and "1-based" in spec[1] and re.search(r"start = page \* page_size", code[1]):
        findings.append(
            {
                "issue": "Off-by-one: the spec says pages are 1-based, but start = page * page_size skips the first page "
                "(page=1, page_size=3 returns items[3:6]). Use start = (page - 1) * page_size.",
                "severity": "high",
                "confidence": 0.92,
            }
        )
    return lab.message(lab.text(json.dumps({"findings": findings})))
