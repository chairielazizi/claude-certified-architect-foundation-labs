"""Checkout flow: price the cart, charge the card, refund on fulfilment failure."""

from app.payments import charge
from app.refunds import issue_refund

CARTS = {"cart-demo": {"customer": "C-1001", "total": 89.90}}


def checkout_cart(cart_id: str) -> dict:
    cart = CARTS[cart_id]
    payment = charge(cart["customer"], cart["total"])
    if not reserve_stock(cart_id):
        issue_refund(payment["payment_id"], cart["total"])
        return {"cart": cart_id, "status": "refunded"}
    return {"cart": cart_id, "status": "paid", "payment": payment["payment_id"]}


def reserve_stock(cart_id: str) -> bool:
    return cart_id != "cart-out-of-stock"
