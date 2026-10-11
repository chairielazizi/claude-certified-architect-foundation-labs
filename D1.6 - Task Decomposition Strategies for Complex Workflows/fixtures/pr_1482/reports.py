"""Nightly revenue report."""
from billing import calculate_total


def daily_revenue(orders):
    return sum(calculate_total(order["items"], region=order["region"]) for order in orders)
