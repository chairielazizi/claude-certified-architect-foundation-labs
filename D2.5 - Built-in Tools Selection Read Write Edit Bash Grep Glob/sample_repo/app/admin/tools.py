"""Back-office actions for support staff."""

from app import refunds


def goodwill_refund(payment_id: str, amount: float, approved_by: str) -> dict:
    if not approved_by:
        raise PermissionError("Goodwill refunds need an approver")
    return refunds.issue_refund(payment_id, amount)
