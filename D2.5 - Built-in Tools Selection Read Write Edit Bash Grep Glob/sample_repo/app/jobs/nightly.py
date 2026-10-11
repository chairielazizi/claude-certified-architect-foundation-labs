"""Nightly batch: refund orders that were cancelled after payment."""

from app.core import refund

CANCELLED = [("pay_C-1001_8990", 89.90)]


def run() -> list[dict]:
    return [refund(payment_id, amount) for payment_id, amount in CANCELLED]
