"""Adapter around the card processor. The only module that talks to the provider."""


class PaymentDeclined(Exception):
    pass


def charge(customer_id: str, amount: float) -> dict:
    if amount <= 0:
        raise ValueError("Charge amount must be positive")
    if customer_id.startswith("C-9"):
        raise PaymentDeclined("Card declined: insufficient funds (PAY-402)")
    return {"payment_id": f"pay_{customer_id}_{int(amount * 100)}", "amount": amount}
