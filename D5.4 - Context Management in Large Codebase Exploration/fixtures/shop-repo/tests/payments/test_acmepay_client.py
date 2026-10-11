from src.payments.acmepay_client import AcmePayClient


def test_refund_posts_amount(http_mock):
    AcmePayClient().refund("ch_1", 8990)
    assert http_mock.last_body["amount"] == 8990
