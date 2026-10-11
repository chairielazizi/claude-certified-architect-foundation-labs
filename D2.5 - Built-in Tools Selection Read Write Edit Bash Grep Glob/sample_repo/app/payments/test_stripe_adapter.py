from app.payments._stripe_adapter import PaymentDeclined, charge


def test_charge_returns_payment_id():
    assert charge("C-1001", 10.0)["payment_id"].startswith("pay_")


def test_declined_card_raises():
    try:
        charge("C-9000", 10.0)
    except PaymentDeclined as exc:
        assert "PAY-402" in str(exc)
