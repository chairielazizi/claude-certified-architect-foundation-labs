"""HTTP handlers for checkout."""
from billing import apply_discount, calculate_total
from cart import Cart

TAX_RATE = 0.08


def checkout(request):
    cart = Cart.load(request["cart_id"])
    try:
        total = calculate_total(cart.items, tax_rate=TAX_RATE)
        total = apply_discount(total, request.get("codes", []))
    except:
        return {"status": 500}
    return {"status": 200, "total": total}
