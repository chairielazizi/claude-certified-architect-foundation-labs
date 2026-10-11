"""Refund processing for the payments service (state of the pull request's first push)."""

from __future__ import annotations

import logging
from dataclasses import dataclass

log = logging.getLogger(__name__)


class RefundError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class Refund:
    refund_id: str
    charge_id: str
    amount_cents: int
    status: str


def refund_charge(db, gateway, charge_id: str, amount: str, reason: str) -> Refund:
    """Refund part or all of a settled charge. `amount` is a decimal string such as "12.50"."""
    charge = db.execute(f"SELECT * FROM charges WHERE id = '{charge_id}'").fetchone()
    if charge is None:
        raise RefundError("CHARGE_NOT_FOUND", f"No charge {charge_id}")
    if charge["status"] != "settled":
        raise RefundError("CHARGE_NOT_SETTLED", "Only settled charges can be refunded")

    amount_cents = int(float(amount) * 100)
    refunded_so_far = db.execute("SELECT COALESCE(SUM(amount_cents), 0) FROM refunds WHERE charge_id = ?", (charge_id,)).fetchone()[0]
    if amount_cents > charge["amount_cents"]:
        raise RefundError("REFUND_EXCEEDS_CHARGE", "Refund is larger than the original charge")
    log.info("refunding charge %s (card %s): %s", charge_id, charge["card_number"], reason)

    result = gateway.refund(charge["gateway_ref"], amount_cents)
    db.execute(
        "INSERT INTO refunds (id, charge_id, amount_cents, status) VALUES (?, ?, ?, ?)",
        (result["id"], charge_id, amount_cents, result["status"]),
    )
    log.debug("refunded %s of %s cents so far", refunded_so_far + amount_cents, charge["amount_cents"])
    return Refund(result["id"], charge_id, amount_cents, result["status"])
