"""D3.6 - Generate tests in CI without repeating the existing suite.

Two inputs decide whether generated tests are worth merging:
  1. CLAUDE.md documents testing standards, what makes a test valuable, and the fixtures available.
     (`claude -p` in CI loads it automatically; through the Messages API we pass it as the system prompt.)
  2. The existing test files are in context, so Claude does not propose scenarios that are already covered.
A deterministic dedupe against the existing tests then catches paraphrased repeats.

Run:  python test_gen.py          (offline: scripted proposals)
      python test_gen.py --live   (real Claude, structured output against ci/test-scenarios.schema.json)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

LAB = Path(__file__).resolve().parents[1]
EXAMPLE_REPO = LAB / "example-repo"
SCHEMA = json.loads((EXAMPLE_REPO / "ci" / "test-scenarios.schema.json").read_text(encoding="utf-8"))
SOURCE = (EXAMPLE_REPO / "src" / "payments" / "refunds.py").read_text(encoding="utf-8")
EXISTING_TESTS = (EXAMPLE_REPO / "tests" / "test_refunds.py").read_text(encoding="utf-8")
CLAUDE_MD = (EXAMPLE_REPO / "CLAUDE.md").read_text(encoding="utf-8")
DOCUMENTED_FIXTURES = {"db", "charge_factory", "fake_gateway", "caplog", "monkeypatch"}
STOPWORDS = {"test", "a", "an", "the", "that", "has", "not", "is", "of", "on", "with", "for", "to", "and", "be", "it", "at"}
SIMILARITY = 0.5


def generation_prompt(include_existing: bool) -> str:
    prompt = f"Propose pytest scenarios for refund_charge.\n\nsrc/payments/refunds.py:\n```python\n{SOURCE}```"
    if include_existing:
        prompt += f"\n\nExisting tests (already covered - do not propose these scenarios again):\n```python\n{EXISTING_TESTS}```"
    return prompt


def system_prompt(include_claude_md: bool) -> str:
    base = "You write pytest tests. Return scenarios only; one behavior per scenario."
    return f"{base}\n\nProject context (CLAUDE.md):\n{CLAUDE_MD}" if include_claude_md else base


def propose(client: Any, system: str, prompt: str) -> list[dict[str, Any]]:
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
    )
    return json.loads(lab.text_of(response))["scenarios"]


def existing_scenarios(source: str) -> list[dict[str, str]]:
    """Test names and docstrings already in the suite."""
    return [{"name": n, "behavior": d} for n, d in re.findall(r'def (test_\w+)\(.*?\):\n\s+"""(.*?)"""', source, re.S)]


def tokens(scenario: dict[str, str]) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", f"{scenario['name']} {scenario['behavior']}".lower()) if w not in STOPWORDS}


def dedupe(proposed: list[dict[str, Any]], existing: list[dict[str, str]]) -> tuple[list[dict[str, Any]], list[tuple[str, str, float]]]:
    """Drop proposals whose name+behavior overlap an existing test by Jaccard >= SIMILARITY."""
    kept, dropped = [], []
    for scenario in proposed:
        scores = [(len(tokens(scenario) & tokens(e)) / len(tokens(scenario) | tokens(e)), e["name"]) for e in existing]
        best, name = max(scores) if scores else (0.0, "")
        if best >= SIMILARITY:
            dropped.append((scenario["name"], name, round(best, 2)))
        else:
            kept.append(scenario)
    return kept, dropped


# ---------------------------------------------------------------------------
# Offline stand-in for Claude: what it proposes depends on what is in its context
# ---------------------------------------------------------------------------

STD = ["db", "charge_factory", "fake_gateway"]
PROPOSALS = [
    # obvious duplicates of existing tests (Claude drops these once it can see the test file)
    {"name": "test_full_refund_of_settled_charge", "behavior": "A full refund of a settled charge succeeds and records the refund.", "fixtures": STD, "catches": "refunds not recorded", "verbatim_duplicate": True},
    {"name": "test_refund_exceeding_charge_rejected", "behavior": "A refund larger than the original charge raises REFUND_EXCEEDS_CHARGE.", "fixtures": STD, "catches": "missing limit check", "verbatim_duplicate": True},
    # a paraphrased duplicate that survives the context and is caught by dedupe()
    {"name": "test_unsettled_charge_refund_rejected", "behavior": "Refunding a charge that has not settled raises CHARGE_NOT_SETTLED.", "fixtures": STD, "catches": "refunding pending charges"},
    # genuinely new, valuable scenarios
    {"name": "test_second_partial_refund_cannot_exceed_charge", "behavior": "Two partial refunds whose total exceeds the charge: the second raises REFUND_EXCEEDS_CHARGE.", "fixtures": STD, "catches": "the limit ignores earlier refunds"},
    {"name": "test_refund_amount_parsed_exactly", "behavior": 'Refunding "1204.35" records exactly 120435 cents.', "fixtures": STD, "catches": "float money conversion"},
    {"name": "test_replayed_idempotency_key_refunds_once", "behavior": "Retrying with the same idempotency key calls the gateway once and returns the original refund.", "fixtures": STD, "catches": "idempotency key not forwarded"},
    {"name": "test_card_number_never_logged", "behavior": "Refund logs contain at most the last four card digits.", "fixtures": [*STD, "caplog"], "catches": "full card number in logs"},
]
LOW_VALUE = {"name": "test_refund_dataclass_fields", "behavior": "Refund has refund_id, charge_id, amount_cents and status fields.", "fixtures": [], "catches": "nothing plausible"}


def scripted_test_writer(params: dict[str, Any]) -> lab.Obj:
    knows_standards = "Available fixtures" in lab.system_text(params)
    sees_tests = "Existing tests" in lab.last_user_text(params)
    scenarios = []
    for p in PROPOSALS:
        if sees_tests and p.get("verbatim_duplicate"):
            continue
        scenario = {k: p[k] for k in ("name", "behavior", "fixtures", "catches")}
        if not knows_standards:
            scenario["fixtures"] = ["mock_db", "mock_gateway"]  # no fixture docs -> invented mocks
        scenarios.append(scenario)
    if not knows_standards:
        scenarios.append(LOW_VALUE)  # no "valuable test" criteria -> filler tests appear
    return lab.message(lab.text(json.dumps({"scenarios": scenarios})))


def show(title: str, scenarios: list[dict[str, Any]]) -> None:
    print(f"  {title}: {len(scenarios)} proposed")
    for s in scenarios:
        print(f"    - {s['name']:<50} fixtures={s['fixtures']}")


def main() -> None:
    lab.banner("D3.6  CI test generation: CLAUDE.md standards + existing tests in context")
    client = lab.get_client(scripted_test_writer)
    existing = existing_scenarios(EXISTING_TESTS)
    print(f"  existing tests: {[e['name'] for e in existing]}")

    lab.section("A. No CLAUDE.md, no existing tests in context")
    bare = propose(client, system_prompt(False), generation_prompt(False))
    show("A", bare)
    _, bare_dupes = dedupe(bare, existing)
    print(f"  duplicates of existing tests: {bare_dupes}")

    lab.section("B. CLAUDE.md as system context + existing tests in the prompt")
    informed = propose(client, system_prompt(True), generation_prompt(True))
    show("B", informed)
    final, dupes = dedupe(informed, existing)
    print(f"  dedupe dropped: {dupes}")
    print(f"  final scenarios to generate: {[s['name'] for s in final]}")

    lab.section("Checks")
    lab.check(all(f"`{f}" in CLAUDE_MD for f in DOCUMENTED_FIXTURES), "the fixtures used for checking are the ones CLAUDE.md documents")
    lab.check(EXISTING_TESTS in generation_prompt(True), "B's prompt includes the existing test file verbatim")
    lab.check(not dedupe(final, existing)[1], "no final scenario duplicates an existing test")
    lab.check(all(set(s["fixtures"]) <= DOCUMENTED_FIXTURES for s in final), "B only uses fixtures documented in CLAUDE.md")
    if not lab.is_live():
        lab.check(len(bare_dupes) == 3 and len(dupes) == 1, "existing tests in context cut duplicates from 3 to 1; dedupe removes the last paraphrase")
        lab.check(any(set(s["fixtures"]) - DOCUMENTED_FIXTURES for s in bare) and LOW_VALUE["name"] in [s["name"] for s in bare], "without CLAUDE.md: invented mocks and a low-value filler test")
        lab.check(len(final) == 4, "4 new, valuable scenarios remain (cumulative limit, exact cents, idempotency, card logging)")


if __name__ == "__main__":
    main()
