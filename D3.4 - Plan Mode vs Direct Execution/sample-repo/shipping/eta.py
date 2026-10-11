import datetime

from common.legacy_dates import format_date, parse_date


def eta_label(shipment):
    """'Arrives 2026-10-14' given an ISO 'shipped' date and 'transit_days'."""
    arrival = parse_date(shipment["shipped"]) + datetime.timedelta(days=shipment["transit_days"])
    return "Arrives " + format_date(arrival)
