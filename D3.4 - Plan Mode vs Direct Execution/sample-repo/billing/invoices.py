from common.legacy_dates import format_date, parse_date


def due_label(invoice):
    """'Due 2026-11-01' for an invoice dict with an ISO 'due' field."""
    due = parse_date(invoice["due"])
    return "Due " + format_date(due)


def is_overdue(invoice, today):
    return parse_date(invoice["due"]) < today
