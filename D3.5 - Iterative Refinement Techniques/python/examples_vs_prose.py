"""D3.5 - Concrete input/output examples beat a prose description of a transformation.

"Uppercase letters, a hyphen, then the number, with any variant at the end" sounds precise, but it
leaves open whether numbers are zero-padded, how the variant is separated, and whether it is
uppercased. Different items (and different runs) get different readings. Two or three examples
answer all of those questions at once.

Run:  python examples_vs_prose.py          (offline: a scripted model shows the effect)
      python examples_vs_prose.py --live   (real Claude, structured JSON output)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

PROSE = (
    "Normalize each product code to our standard format: uppercase category letters, a hyphen, then the "
    "item number, with any variant at the end."
)
EXAMPLES = [("ab 12", "AB-0012"), ("kt_9_red", "KT-0009-RED"), ("Xy-0457", "XY-0457")]
CODES = ["  pd 101  ", "zz-7 blue", "LM/88/xl", "cd 5", "Rt-3030", "gh_42_Navy"]
EXPECTED = ["PD-0101", "ZZ-0007-BLUE", "LM-0088-XL", "CD-0005", "RT-3030", "GH-0042-NAVY"]
CANONICAL = re.compile(r"^[A-Z]{2}-\d{4}(?:-[A-Z]+)?$")
OUTPUT_FORMAT = {
    "type": "json_schema",
    "schema": {
        "type": "object",
        "properties": {"codes": {"type": "array", "items": {"type": "string"}}},
        "required": ["codes"],
        "additionalProperties": False,
    },
}


def build_prompt(codes: list[str], examples: list[tuple[str, str]] | None = None) -> str:
    lines = [PROSE]
    if examples:
        lines += ["", "Examples:"] + [f"{json.dumps(src)} -> {json.dumps(dst)}" for src, dst in examples]
    lines += ["", "Return the normalized codes in the same order.", f"Codes: {json.dumps(codes)}"]
    return "\n".join(lines)


def normalize(client: Any, prompt: str) -> list[str]:
    response = client.messages.create(
        model=lab.MODEL,
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
        output_config={"format": OUTPUT_FORMAT},  # structured output: the text block is valid JSON
    )
    return json.loads(lab.text_of(response))["codes"]


def shape(code: str) -> str:
    """'ZZ-7 blue' -> 'AA-9 aaaa': makes formatting differences visible at a glance."""
    return re.sub(r"[a-z]", "a", re.sub(r"[A-Z]", "A", re.sub(r"\d", "9", code)))


# ---------------------------------------------------------------------------
# Offline stand-in for Claude
# ---------------------------------------------------------------------------

PARTS = re.compile(r"^\s*([A-Za-z]{2})[\s_/-]*(\d+)(?:[\s_/-]+([A-Za-z]+))?\s*$")

# Three readings the prose genuinely allows; nothing in the sentence rules any of them out.
READINGS = [
    lambda cat, num, var: f"{cat.upper()}-{num}" + (f" {var}" if var else ""),  # no padding, variant after a space
    lambda cat, num, var: f"{cat.upper()}-{int(num):04d}" + (f"-{var.upper()}" if var else ""),  # padded, hyphenated
    lambda cat, num, var: f"{cat.upper()}{num}" + (f"-{var.upper()}" if var else ""),  # the hyphen read as the variant's
]


def scripted_model(params: dict[str, Any]) -> lab.Obj:
    prompt = lab.last_user_text(params)
    codes = json.loads(prompt.rsplit("Codes: ", 1)[1])
    examples = [(json.loads(a), json.loads(b)) for a, b in re.findall(r'^(".*") -> (".*")$', prompt, re.M)]
    out = []
    if examples:
        # The examples pin down every open question: read the padding width and the variant
        # separator straight off them, then apply that one rule to every input.
        width = max(len(re.search(r"\d+", dst).group(0)) for _, dst in examples)  # type: ignore[union-attr]
        with_variant = next(dst for _, dst in examples if re.search(r"\d([^\d])[A-Z]+$", dst))
        sep = re.search(r"\d([^\d])[A-Z]+$", with_variant).group(1)  # type: ignore[union-attr]
        for code in codes:
            cat, num, var = PARTS.match(code).groups()  # type: ignore[union-attr]
            out.append(f"{cat.upper()}-{int(num):0{width}d}" + (f"{sep}{var.upper()}" if var else ""))
    else:
        # Simulated ambiguity: each item gets one of the readings the prose allows.
        for i, code in enumerate(codes):
            cat, num, var = PARTS.match(code).groups()  # type: ignore[union-attr]
            out.append(READINGS[i % len(READINGS)](cat, num, var))
    return lab.message(lab.text(json.dumps({"codes": out})))


def main() -> None:
    lab.banner("D3.5  Concrete input/output examples vs a prose description")
    client = lab.get_client(scripted_model)

    lab.section("A. Prose description only")
    prose_out = normalize(client, build_prompt(CODES))
    for src, dst in zip(CODES, prose_out):
        print(f"  {json.dumps(src):<14} -> {dst:<16} shape {shape(dst)}")

    lab.section("B. Same prose + 3 concrete examples")
    print("  " + build_prompt(CODES, EXAMPLES).split("Examples:\n", 1)[1].split("\n\n", 1)[0].replace("\n", "\n  "))
    example_out = normalize(client, build_prompt(CODES, EXAMPLES))
    for src, dst in zip(CODES, example_out):
        print(f"  {json.dumps(src):<14} -> {dst:<16} shape {shape(dst)}")

    lab.section("Checks")
    def canonical(codes: list[str]) -> int:
        return sum(bool(CANONICAL.match(c)) for c in codes)

    print(f"  in the intended format (AA-9999[-VARIANT]): prose {canonical(prose_out)}/{len(CODES)}, examples {canonical(example_out)}/{len(CODES)}")
    lab.check(len(example_out) == len(CODES) and len(prose_out) == len(CODES), "both prompts returned one code per input (structured output)")
    if not lab.is_live():
        lab.check(not all(CANONICAL.match(c) for c in prose_out), "prose alone: padding and variant format come out inconsistent")
        lab.check(example_out == EXPECTED, "with 3 examples: every code matches the intended format exactly")


if __name__ == "__main__":
    main()
