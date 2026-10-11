"""D4.2 - Few-shot examples fix empty/null extraction from documents with varied structures.

    zero-shot           -> methodology null when there is no "Methods" heading, citations
                           empty when they live in a bibliography, informal amounts dropped
    1 generic example   -> format fixed, the same fields still empty (examples must TARGET
                           the hard cases)
    2 targeted examples -> bibliography, embedded methods, "a couple of cups" all extracted,
                           including a structure no example showed (footnote-style Notes)

Run:  python extraction_fewshot.py          (offline, scripted model)
      python extraction_fewshot.py --live   (real Claude API)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from fewshot_prompts import (  # noqa: E402
    GENERIC_EXAMPLE,
    TARGETED_EXAMPLES,
    build_extraction_prompt,
    extraction_user_message,
    load_json,
)
from scoring import PaperExtraction, missing_required, parse_extraction  # noqa: E402
from scripted_model import extraction_model  # noqa: E402

DOCS: list[dict[str, Any]] = load_json("research_docs.json")["documents"]


def run(name: str, system: str) -> tuple[dict[str, PaperExtraction | None], dict[str, list[str]]]:
    lab.section(name)
    client = lab.get_client(extraction_model)
    extractions: dict[str, PaperExtraction | None] = {}
    missing: dict[str, list[str]] = {}
    for doc in DOCS:
        response = client.messages.create(
            model=lab.MODEL,
            max_tokens=4000,
            system=system,
            messages=[{"role": "user", "content": extraction_user_message(doc)}],
        )
        ex = parse_extraction(lab.text_of(response))
        extractions[doc["id"]], missing[doc["id"]] = ex, missing_required(ex, doc["expected"])
        exp = doc["expected"]
        found = (
            "unparseable output"
            if ex is None
            else f"methodology={'yes' if ex.methodology else 'NULL'}  citations={len(ex.citations)}/{exp['citations']}  "
            f"measurements={len(ex.measurements)}/{exp['measurements']}"
        )
        print(f"  {doc['id']} [{doc['structure'][:50]}]\n     {found}  missing={missing[doc['id']]}")
    print(f"  -> required fields empty although present in the source: {sum(len(m) for m in missing.values())}")
    return extractions, missing


def total(missing: dict[str, list[str]]) -> int:
    return sum(len(m) for m in missing.values())


def main() -> None:
    lab.banner("D4.2  Few-shot examples for varied document structures")
    _, zero_missing = run("zero-shot: instructions only", build_extraction_prompt())
    _, generic_missing = run("few-shot: 1 generic example", build_extraction_prompt([GENERIC_EXAMPLE]))
    targeted, targeted_missing = run("few-shot: 2 targeted examples with reasoning", build_extraction_prompt(TARGETED_EXAMPLES))

    lab.section("Informal measurements (P3) with targeted examples")
    p3 = targeted["P3"].measurements if targeted["P3"] else []
    for m in p3:
        print(f"  {m.original_text!r:<32} -> quantity={m.quantity} unit={m.unit} approximate={m.approximate}")

    if not lab.is_live():
        p2, p4 = targeted["P2"], targeted["P4"]
        lab.check(total(zero_missing) > 0, "zero-shot leaves required fields empty on non-standard documents")
        lab.check(total(generic_missing) == total(zero_missing), "a generic example fixes the format, not the hard cases")
        lab.check(total(targeted_missing) == 0, "targeted examples: no required field left empty")
        lab.check(
            p2 is not None and len(p2.citations) == 2 and p2.methodology is not None,
            "P2: citations read from the bibliography, methodology found without a Methods heading",
        )
        lab.check(
            any(m.original_text.startswith("a couple of cups") and m.quantity == 2 and m.unit == "cup" and m.approximate for m in p3),
            "'a couple of cups' -> quantity 2, unit cup, approximate (kept, not dropped or invented)",
        )
        lab.check(
            p4 is not None and len(p4.citations) == 1 and not targeted_missing["P4"],
            "P4 (footnote Notes, 'Approach' label - in no example) also extracted: the model generalized",
        )


if __name__ == "__main__":
    main()
