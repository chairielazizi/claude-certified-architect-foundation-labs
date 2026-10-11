"""Decides whether an order can still be refunded."""
from datetime import date

RETURN_WINDOW_DAYS = 45


class WindowExpired(Exception):
    pass


class NotDelivered(Exception):
    pass


class ReturnEligibilityGate:
    def check(self, order, today=None):
        if order.delivered_on is None:
            raise NotDelivered(order.order_id)
        days = ((today or date.today()) - order.delivered_on).days
        if days > RETURN_WINDOW_DAYS:
            raise WindowExpired(f"{order.order_id}: {days} days since delivery")
