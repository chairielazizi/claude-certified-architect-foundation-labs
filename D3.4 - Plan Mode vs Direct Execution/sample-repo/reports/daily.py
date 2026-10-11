from common.legacy_dates import format_date


def report_header(day, order_count):
    return f"Daily report {format_date(day)}: {order_count} orders"
