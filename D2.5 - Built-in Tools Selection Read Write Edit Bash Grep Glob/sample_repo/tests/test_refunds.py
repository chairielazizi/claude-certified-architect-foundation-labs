from app.refunds import issue_refund


def test_issue_refund_returns_id():
    assert issue_refund("pay_1", 5.0)["refund_id"] == "rf_pay_1"
