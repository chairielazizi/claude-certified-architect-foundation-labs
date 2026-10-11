"""The test suite for the customer-record migration, written BEFORE any implementation exists.

Contract under test (the implementation lives in a separate file Claude writes):

    migrate_customer(record: dict, countries: dict[str, str]) -> dict
        legacy v1 record -> v2 record
    migrate_all(records: list[dict], load_countries: Callable[[], dict[str, str]]) -> list[dict]
        migrates a batch; load_countries() is an expensive lookup (a database round trip)

v1: {"id": "17", "name": " Ada Lovelace ", "email": "ADA@Example.COM", "phone": "(555) 010-2233",
     "signup": "03/14/2019" or "2019-03-14", "balance": "1,204.35", "country": "uk"}
v2: {"id": 17, "full_name": "Ada Lovelace", "email": "ada@example.com", "phone": "+15550102233",
     "signup_date": "2019-03-14", "balance_cents": 120435, "country": "GB"}

Legacy data is dirty: any field except id may be null (None) or missing entirely.
This file is data only, so the same cases can be shown to Claude verbatim and run by the harness.
"""

COUNTRIES = {"uk": "GB", "usa": "US", "de": "DE"}

BASE = {
    "id": "17",
    "name": " Ada Lovelace ",
    "email": "ADA@Example.COM",
    "phone": "(555) 010-2233",
    "signup": "2019-03-14",
    "balance": "12.50",
    "country": "uk",
}
BASE_OUT = {
    "id": 17,
    "full_name": "Ada Lovelace",
    "email": "ada@example.com",
    "phone": "+15550102233",
    "signup_date": "2019-03-14",
    "balance_cents": 1250,
    "country": "GB",
}


def case(name: str, changes: dict, expected_changes: dict, drop: tuple[str, ...] = ()) -> dict:
    record = {k: v for k, v in {**BASE, **changes}.items() if k not in drop}
    return {"name": name, "input": record, "expected": {**BASE_OUT, **expected_changes}}


CASES = [
    # expected behavior
    case("migrates a complete record", {}, {}),
    case("trims the name and lowercases the email", {"name": "  Grace Hopper ", "email": " Grace@Navy.MIL "}, {"full_name": "Grace Hopper", "email": "grace@navy.mil"}),
    case("converts the legacy MM/DD/YYYY signup date to ISO", {"signup": "03/14/2019"}, {}),
    case("parses a balance with a thousands separator exactly", {"balance": "1,204.35"}, {"balance_cents": 120435}),
    case("maps the country through the lookup table", {"country": "usa"}, {"country": "US"}),
    # edge cases: null and missing values
    case("keeps a null phone as null", {"phone": None}, {"phone": None}),
    case("treats a missing email as null", {}, {"email": None}, drop=("email",)),
    case("treats a null balance as zero cents", {"balance": None}, {"balance_cents": 0}),
    case("keeps a null signup date as null", {"signup": None}, {"signup_date": None}),
    case("leaves an unknown country as null", {"country": "atlantis"}, {"country": None}),
]

# Performance requirement: migrating a 20k-record batch looks the country table up ONCE (it is a
# database round trip in production) and finishes well inside the batch window.
PERF = {"name": "migrate_all loads the country table once for 20,000 records", "records": 20_000, "max_loads": 1, "max_seconds": 2.0}
