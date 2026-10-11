"""Billing helpers. This PR replaces the caller-supplied tax rate with a per-region table."""

REGION_TAX_RATES = {"US-CA": 0.0725, "US-NY": 0.04, "EU-DE": 0.19}


def calculate_total(items, region):
    subtotal = sum(item["price"] * item["qty"] for item in items)
    return round(subtotal * (1 + REGION_TAX_RATES[region]), 2)


def apply_discount(total, codes=[]):
    for code in codes:
        if code == "WELCOME10":
            total = total * 0.9
    codes.append("APPLIED")
    return total
