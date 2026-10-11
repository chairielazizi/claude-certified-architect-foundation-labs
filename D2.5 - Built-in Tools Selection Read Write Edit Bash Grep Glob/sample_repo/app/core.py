"""Core money movements shared by checkout, admin tools and batch jobs."""

from datetime import date, timedelta

from config.settings import REFUNDS


class RefundWindowExpired(Exception):
    pass


def refund(payment_id: str, amount: float, paid_on: date | None = None) -> dict:
    paid_on = paid_on or date.today()
    if date.today() - paid_on > timedelta(days=REFUNDS["window_days"]):
        raise RefundWindowExpired("Refund window expired (RF-410)")
    return {"refund_id": f"rf_{payment_id}", "amount": amount}
