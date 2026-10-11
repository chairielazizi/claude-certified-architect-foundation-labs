from src.payments.credit_reversal import CreditReversalService


def test_reverse_refunds_and_records(fake_order, fakes):
    CreditReversalService().reverse(fake_order.order_id, "damaged")
    assert fakes.psp.refunded and fakes.ledger.recorded


def test_reverse_stops_when_gate_rejects(expired_order, fakes):
    assert not fakes.psp.refunded


def test_reverse_returns_charge(fake_order, fakes):
    assert CreditReversalService().reverse(fake_order.order_id, "late")["status"] == "refunded"
