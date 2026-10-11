"""D2.5 - Trace function usage across wrapper modules: collect every exported name first.

Task: "find every place that moves money through core.refund / the card adapter's charge".

  naive:         Grep the function name once ("\\brefund\\(")
                 -> misses callers that use a re-exported alias (issue_refund, capture_payment)
  alias-aware:   1. Grep import lines for the name and collect every alias / re-export
                    (refunds.py: 'from .core import refund as issue_refund'), repeat for each
                    new alias until no new names appear
                 2. Grep for calls of EACH name

Always offline. Run:  python trace_wrappers.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from code_nav import imported_names  # noqa: E402
from mini_tools import Workspace  # noqa: E402

SAMPLE_REPO = Path(__file__).resolve().parents[1] / "sample_repo"


def exported_names(ws: Workspace, name: str) -> tuple[set[str], list[str]]:
    """Every name the function is reachable under, found from import / re-export lines."""
    names, frontier, evidence = {name}, [name], []
    while frontier:
        current = frontier.pop()
        for path, line_no, line in ws.grep(rf"import .*\b{current}\b"):
            for original, local in imported_names(line):
                if original == current and local not in names:
                    names.add(local)
                    frontier.append(local)
                    evidence.append(f"{path}:{line_no}  {line}")
    return names, evidence


def call_sites(ws: Workspace, names: set[str]) -> list[str]:
    hits = []
    for name in sorted(names):
        hits += [f"{p}:{n}" for p, n, line in ws.grep(rf"\b{name}\(") if not line.startswith("def ")]
    return sorted(set(hits))


def main() -> None:
    lab.banner("D2.5  Tracing usage across wrapper modules and aliases")
    ws = Workspace(SAMPLE_REPO)
    results = {}
    for target in ("refund", "charge"):
        lab.section(f"Who calls {target}()?")
        naive = call_sites(ws, {target})
        names, evidence = exported_names(ws, target)
        aware = call_sites(ws, names)
        print(f"  naive Grep '\\b{target}\\(':  {naive}")
        print(f"  names found from import lines: {sorted(names)}")
        for line in evidence:
            print(f"      {line}")
        print(f"  alias-aware Grep:  {aware}")
        print(f"  missed by the naive search: {sorted(set(aware) - set(naive))}")
        results[target] = (set(naive), set(aware), names)

    lab.section("Checks")
    naive_r, aware_r, names_r = results["refund"]
    lab.check(names_r == {"refund", "issue_refund"}, "refund is also exported as issue_refund (refunds.py wrapper)")
    lab.check(naive_r < aware_r, "alias-aware search finds strictly more call sites than the naive one")
    lab.check(
        {"app/checkout.py", "app/admin/tools.py"} <= {s.split(":")[0] for s in aware_r - naive_r},
        "checkout.py and admin/tools.py (refunds.issue_refund) were invisible to the naive Grep",
    )
    naive_c, aware_c, names_c = results["charge"]
    lab.check(names_c == {"charge", "capture_payment"}, "charge is re-exported by payments/__init__.py, once under an alias")
    lab.check(any(s.startswith("app/jobs/reconcile.py") for s in aware_c - naive_c), "the reconcile job's capture_payment() call is found only via the alias")


if __name__ == "__main__":
    main()
