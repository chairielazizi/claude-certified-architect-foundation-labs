"""D2.5 - Build understanding incrementally: Grep for the entry point, Read, follow imports.

Question: "When the app checks out a cart, where is the card actually charged?"

    1. Grep  for the entry point (__name__ == "__main__")          -> app/main.py
    2. Read  app/main.py, see checkout_cart imported from app.checkout
    3. Read  app/checkout.py (where checkout_cart is defined); it calls charge()
    4. follow 'from app.payments import charge' -> app/payments/__init__.py (a re-export)
    5. follow 'from ._stripe_adapter import charge' -> app/payments/_stripe_adapter.py: def charge
    6. Grep  the decline message to confirm the provider call lives there (no extra Read)

Only the files on the path are read, instead of loading the whole repository upfront.
Always offline. Run:  python incremental_exploration.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from code_nav import parse_imports, resolve_module  # noqa: E402
from mini_tools import Workspace  # noqa: E402

SAMPLE_REPO = Path(__file__).resolve().parents[1] / "sample_repo"


def trace(ws: Workspace, symbol: str, file: str, steps: list[str], seen: dict[str, str]) -> str:
    """Follow ``symbol`` through import / re-export / alias chains to its definition."""
    source = seen.get(file) or ws.read(file)  # don't re-Read a file already in context
    seen[file] = source
    if re.search(rf"^\s*def {symbol}\(", source, re.M):
        steps.append(f"{file}: def {symbol}(...)  <- defined here")
        return file
    imports = parse_imports(source)
    if symbol not in imports:
        raise LookupError(f"{symbol} is neither defined nor imported in {file}")
    module, original = imports[symbol]
    target = resolve_module(module, file, ws.all_files())
    if target is None:
        raise LookupError(f"cannot resolve {module} from {file}")
    alias = f" (alias of {original})" if original != symbol else ""
    steps.append(f"{file}: {symbol}{alias} imported from {module} -> {target}")
    return trace(ws, original, target, steps, seen)


def main() -> None:
    lab.banner("D2.5  Incremental exploration: Grep -> Read -> follow imports")
    ws = Workspace(SAMPLE_REPO)
    everything = ws.all_files()
    steps: list[str] = []
    seen: dict[str, str] = {}

    lab.section("Step 1: Grep for the entry point")
    entry_hits = ws.grep('__name__ == "__main__"')
    entry = entry_hits[0][0]
    print(f"  {entry_hits}")

    lab.section("Steps 2-5: Read and follow imports")
    main_source = ws.read(entry)
    seen[entry] = main_source
    called = [name for name in re.findall(r"(\w+)\(", main_source) if name in parse_imports(main_source)]
    print(f"  {entry} calls imported: {called}")
    checkout_file = trace(ws, called[0], entry, steps, seen)
    charge_file = trace(ws, "charge", checkout_file, steps, seen)
    for step in steps:
        print(f"  {step}")

    lab.section("Step 6: confirm with Grep (no extra Read)")
    decline = ws.grep(r"Card declined")
    print(f"  {decline}")

    lab.section("What was loaded")
    read = list(dict.fromkeys(ws.files_read))
    chars_read = sum(len(seen[f]) for f in read)
    chars_all = sum(len((SAMPLE_REPO / f).read_text(encoding="utf-8")) for f in everything)
    print(f"  tool calls: {ws.calls}")
    print(f"  files read: {len(read)}/{len(everything)}  chars read: {chars_read}/{chars_all} ({chars_read / chars_all:.0%})")

    lab.section("Checks")
    lab.check(entry == "app/main.py", "Grep found the entry point without opening any file")
    lab.check(charge_file == "app/payments/_stripe_adapter.py", "followed main -> checkout -> payments/__init__ (re-export) -> _stripe_adapter")
    lab.check(decline and decline[0][0] == charge_file, "the decline error message confirms the provider call site")
    lab.check(len(read) == 4 and len(read) < len(everything) / 4, f"read only the {len(read)} files on the path, not all {len(everything)}")
    lab.check(chars_read < 0.4 * chars_all, "a fraction of the repository's text entered the context")


if __name__ == "__main__":
    main()
