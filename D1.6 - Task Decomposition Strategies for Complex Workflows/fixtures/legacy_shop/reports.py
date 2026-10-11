# criticality: low
"""Nightly revenue report."""
import db
from pricing import with_tax
from utils import money


def revenue_for(day):
    rows = db.connect().execute("SELECT total FROM orders WHERE day = ?", (day,)).fetchall()
    return money(with_tax(sum(r[0] for r in rows), 0.08))
