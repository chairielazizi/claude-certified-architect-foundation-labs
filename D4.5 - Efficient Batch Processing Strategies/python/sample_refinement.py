"""D4.5 - Refine the prompt on a small sample with the synchronous API BEFORE batching.

    5 sample docs, sync API (answers in seconds) -> measure first-pass success
    v1 prompt: dates copied as printed           -> 60%: would fail ~10 of 24 in the batch
    v2 prompt: explicit JSON shape + YYYY-MM-DD  -> 100%: go
    then submit the full set once, instead of discovering the problem 24 hours later

Run:  python sample_refinement.py          (offline, scripted model)
      python sample_refinement.py --live   (real Claude API, synchronous calls on the sample)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from batch_workload import PROMPT_V1, PROMPT_V2, build_request, extraction_model, make_documents, parse_output  # noqa: E402

GO_THRESHOLD = 0.95


def first_pass_success(client: Any, system: str, docs: list[dict[str, Any]]) -> tuple[float, dict[str, str]]:
    failures = {}
    for doc in docs:
        params = build_request(doc["id"], doc["text"], system)["params"]  # same params the batch will use
        response = client.messages.create(**params)
        parsed, why = parse_output(lab.text_of(response))
        if parsed is None:
            failures[doc["id"]] = why
    return 1 - len(failures) / len(docs), failures


def main() -> None:
    lab.banner("D4.5  Prompt refinement on a sample before batching")
    docs = make_documents()
    sample = docs[::5]  # 5 of 24, spread across the set
    client = lab.get_client(extraction_model)
    print(f"  sample: {[d['id'] for d in sample]} ({len(sample)} of {len(docs)} documents, synchronous API)")

    results = {}
    for name, prompt in (("v1", PROMPT_V1), ("v2", PROMPT_V2)):
        lab.section(f"prompt {name}")
        rate, failures = first_pass_success(client, prompt, sample)
        projected = round((1 - rate) * len(docs))
        decision = "GO: submit the full batch" if rate >= GO_THRESHOLD else "REFINE: do not batch yet"
        results[name] = (rate, decision)
        for doc_id, why in failures.items():
            print(f"  {doc_id}: {why}")
        print(f"  first-pass success {rate:.0%} -> projected failures in the full batch: ~{projected} -> {decision}")

    lab.section("Why this order")
    print("  A bad prompt found in the batch costs a full round trip (up to 24h) plus resubmitting")
    print("  every failed document. Found on 5 synchronous calls, it costs seconds.")

    if not lab.is_live():
        lab.check(results["v1"][0] < 0.8 and results["v1"][1].startswith("REFINE"), "v1 fails on the sample (dates as printed), so it is not batched")
        lab.check(results["v2"][0] == 1.0 and results["v2"][1].startswith("GO"), "v2 passes every sample document: ready for the batch")
    lab.check(len(sample) <= len(docs) // 4, "refinement ran on a small sample, not on the whole set")


if __name__ == "__main__":
    main()
