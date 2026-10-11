from src.api.refunds import post_refund


def test_post_refund_returns_charge(fake_request):
    assert post_refund(fake_request(order_id="ORD-1", reason="damaged"))["status"] == "refunded"


def test_post_refund_requires_reason(fake_request):
    assert post_refund(fake_request(order_id="ORD-1")) is None
