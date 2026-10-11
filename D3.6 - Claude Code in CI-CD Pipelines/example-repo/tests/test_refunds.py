import pytest

from payments.refunds import RefundError, refund_charge


def test_full_refund_succeeds(db, charge_factory, fake_gateway):
    """A full refund of a settled charge calls the gateway once and records the refund."""
    charge_id = charge_factory(amount_cents=5000)
    refund = refund_charge(db, fake_gateway, charge_id, "50.00", "customer request")
    assert refund.amount_cents == 5000
    assert refund.status == "succeeded"
    assert len(fake_gateway.calls) == 1


def test_refund_larger_than_charge_is_rejected(db, charge_factory, fake_gateway):
    """A refund larger than the original charge raises REFUND_EXCEEDS_CHARGE and never calls the gateway."""
    charge_id = charge_factory(amount_cents=5000)
    with pytest.raises(RefundError) as exc:
        refund_charge(db, fake_gateway, charge_id, "50.01", "typo")
    assert exc.value.code == "REFUND_EXCEEDS_CHARGE"
    assert fake_gateway.calls == []


def test_refund_requires_settled_charge(db, charge_factory, fake_gateway):
    """Refunding a charge that has not settled raises CHARGE_NOT_SETTLED."""
    charge_id = charge_factory(status="pending")
    with pytest.raises(RefundError) as exc:
        refund_charge(db, fake_gateway, charge_id, "10.00", "duplicate order")
    assert exc.value.code == "CHARGE_NOT_SETTLED"


def test_unknown_charge_is_rejected(db, fake_gateway):
    """Refunding a charge id that does not exist raises CHARGE_NOT_FOUND."""
    with pytest.raises(RefundError) as exc:
        refund_charge(db, fake_gateway, "ch_missing", "10.00", "n/a")
    assert exc.value.code == "CHARGE_NOT_FOUND"
