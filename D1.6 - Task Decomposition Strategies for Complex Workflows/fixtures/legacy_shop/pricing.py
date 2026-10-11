# criticality: high
"""Price calculations: line totals, bulk discounts, tax."""


def line_total(price, qty):
    return round(price * qty, 2)


def bulk_discount(qty):
    if qty >= 100:
        return 0.15
    if qty >= 10:
        return 0.05
    return 0.0


def with_tax(amount, rate):
    return round(amount * (1 + rate), 2)
