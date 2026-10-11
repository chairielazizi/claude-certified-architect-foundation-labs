"""Shared fixtures. CLAUDE.md lists these so generated tests use them instead of inventing mocks."""

import sqlite3

import pytest


@pytest.fixture
def db():
    """In-memory database with the real charges/refunds schema."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE charges (id TEXT PRIMARY KEY, amount_cents INTEGER, status TEXT, card_number TEXT, gateway_ref TEXT);
        CREATE TABLE refunds (id TEXT PRIMARY KEY, charge_id TEXT, amount_cents INTEGER, status TEXT);
        """
    )
    yield conn
    conn.close()


@pytest.fixture
def charge_factory(db):
    """charge_factory(amount_cents=5000, status="settled") inserts a charge and returns its id."""
    counter = iter(range(1, 10_000))

    def make(amount_cents=5000, status="settled", card_number="4111111111111111"):
        charge_id = f"ch_{next(counter)}"
        db.execute("INSERT INTO charges VALUES (?, ?, ?, ?, ?)", (charge_id, amount_cents, status, card_number, f"gw_{charge_id}"))
        return charge_id

    return make


class FakeGateway:
    """Records refund calls; replays the stored response for a repeated idempotency key."""

    def __init__(self):
        self.calls = []
        self.by_key = {}

    def refund(self, gateway_ref, amount_cents, idempotency_key=None):
        if idempotency_key in self.by_key:
            return self.by_key[idempotency_key]
        self.calls.append((gateway_ref, amount_cents, idempotency_key))
        response = {"id": f"re_{len(self.calls)}", "status": "succeeded"}
        if idempotency_key:
            self.by_key[idempotency_key] = response
        return response


@pytest.fixture
def fake_gateway():
    return FakeGateway()
