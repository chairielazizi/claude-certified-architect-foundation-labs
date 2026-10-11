"""Reconcile job: re-captures payments the provider reported as pending."""

from app.payments import capture_payment

PENDING = [("C-1002", 25.00)]


def run() -> list[dict]:
    return [capture_payment(customer, amount) for customer, amount in PENDING]
