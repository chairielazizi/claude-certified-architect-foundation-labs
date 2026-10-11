"""Offline stand-in for Claude in the test-driven iteration demo.

The scripted model is driven by what the prompt contains, as the real one is: with no failures listed
it writes a first attempt; given failures it returns a revision addressing them. Revision 2 fixes every
listed failure, but one fix is subtly wrong (float money), and the next test run catches it. That is
the realistic shape of test-driven iteration: each round's failures say exactly what to fix next.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402

FIRST_ATTEMPT = '''from datetime import date


def migrate_customer(record, countries):
    return {
        "id": int(record["id"]),
        "full_name": record["name"].strip(),
        "email": record["email"].strip().lower(),
        "phone": "+1" + "".join(ch for ch in record["phone"] if ch.isdigit()),
        "signup_date": date.fromisoformat(record["signup"]).isoformat(),
        "balance_cents": int(float(record["balance"]) * 100),
        "country": countries[record["country"]],
    }


def migrate_all(records, load_countries):
    return [migrate_customer(record, load_countries()) for record in records]
'''

# Handles nulls, missing keys, both date formats, separators and the single table load...
# but converts money through float: int(float("1204.35") * 100) == 120434.
SECOND_ATTEMPT = '''from datetime import date, datetime


def _clean(value):
    if value is None:
        return None
    value = str(value).strip()
    return value or None


def _phone(raw):
    raw = _clean(raw)
    if raw is None:
        return None
    digits = "".join(ch for ch in raw if ch.isdigit())
    return "+" + ("1" + digits if len(digits) == 10 else digits)


def _date(raw):
    raw = _clean(raw)
    if raw is None:
        return None
    if "/" in raw:
        return datetime.strptime(raw, "%m/%d/%Y").date().isoformat()
    return date.fromisoformat(raw).isoformat()


def _cents(raw):
    raw = _clean(raw)
    return 0 if raw is None else int(float(raw.replace(",", "")) * 100)


def migrate_customer(record, countries):
    email = _clean(record.get("email"))
    country = _clean(record.get("country"))
    return {
        "id": int(record["id"]),
        "full_name": _clean(record.get("name")),
        "email": email.lower() if email else None,
        "phone": _phone(record.get("phone")),
        "signup_date": _date(record.get("signup")),
        "balance_cents": _cents(record.get("balance")),
        "country": countries.get(country.lower()) if country else None,
    }


def migrate_all(records, load_countries):
    countries = load_countries()  # one database round trip per batch, not per record
    return [migrate_customer(record, countries) for record in records]
'''

THIRD_ATTEMPT = SECOND_ATTEMPT.replace(
    "from datetime import date, datetime\n",
    "from datetime import date, datetime\nfrom decimal import Decimal\n",
).replace(
    'int(float(raw.replace(",", "")) * 100)',
    'int(Decimal(raw.replace(",", "")) * 100)  # exact decimal arithmetic for money',
)

MONEY_TEST = "parses a balance with a thousands separator exactly"


def failing_tests(prompt: str) -> list[str]:
    """Names of the failing tests listed in a fix prompt."""
    section = prompt.split("Failing tests:", 1)[1] if "Failing tests:" in prompt else ""
    return re.findall(r"^- (.+)$", section, re.M)


def scripted_claude(params: dict[str, Any]) -> lab.Obj:
    failures = failing_tests(lab.last_user_text(params))
    if not failures:
        code, note = FIRST_ATTEMPT, "First implementation of migrate_customer and migrate_all."
    elif failures == [MONEY_TEST]:
        code, note = THIRD_ATTEMPT, "Switched money parsing from float to Decimal so 1,204.35 becomes exactly 120435 cents."
    else:
        code, note = SECOND_ATTEMPT, "Handled null/missing fields, MM/DD/YYYY dates, thousands separators and unknown countries; load the country table once per batch."
    return lab.message(lab.text(f"```python\n{code}```\n\n{note}"))
