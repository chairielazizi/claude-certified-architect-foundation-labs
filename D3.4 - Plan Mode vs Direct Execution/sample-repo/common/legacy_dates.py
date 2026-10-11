"""Deprecated hand-rolled date helpers (2016). New code uses the standard library directly."""

import datetime


def parse_date(text):
    """Parse 'YYYY-MM-DD' into a datetime.date."""
    year, month, day = (int(part) for part in text.split("-"))
    return datetime.date(year, month, day)


def format_date(value):
    """Format a date as 'YYYY-MM-DD'."""
    return "%04d-%02d-%02d" % (value.year, value.month, value.day)


def days_between(start, end):
    """Whole days from start to end (negative if end is earlier)."""
    return (end - start).days
