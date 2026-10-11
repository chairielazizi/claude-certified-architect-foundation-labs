from common.legacy_dates import days_between, parse_date


def days_overdue(invoice, today):
    """How many days past due an invoice is (0 if not yet due)."""
    return max(0, days_between(parse_date(invoice["due"]), today))
