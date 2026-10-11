from app.checkout import checkout_cart


def test_checkout_charges_card():
    assert checkout_cart("cart-demo")["status"] == "paid"
