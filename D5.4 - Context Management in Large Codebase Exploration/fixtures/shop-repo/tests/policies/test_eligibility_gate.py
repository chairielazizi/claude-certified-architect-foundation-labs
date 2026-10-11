from datetime import date, timedelta

import pytest

from src.policies.eligibility_gate import ReturnEligibilityGate, WindowExpired

TODAY = date(2026, 10, 11)


def make_order(days_ago):
    return type("O", (), {"order_id": "ORD-1", "delivered_on": TODAY - timedelta(days=days_ago)})()


def test_within_window():
    ReturnEligibilityGate().check(make_order(days_ago=10), today=TODAY)


def test_expired_window():
    with pytest.raises(WindowExpired):
        ReturnEligibilityGate().check(make_order(days_ago=60), today=TODAY)
