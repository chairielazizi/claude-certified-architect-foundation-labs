"""Behavior of every caller of the date helpers. Must pass before AND after the migration."""

import datetime
import unittest

from billing.invoices import due_label, is_overdue
from billing.reminders import days_overdue
from reports.daily import report_header
from shipping.eta import eta_label

TODAY = datetime.date(2026, 10, 11)


class CallerBehavior(unittest.TestCase):
    def test_due_label(self):
        self.assertEqual(due_label({"due": "2026-11-01"}), "Due 2026-11-01")

    def test_is_overdue(self):
        self.assertTrue(is_overdue({"due": "2026-10-01"}, TODAY))
        self.assertFalse(is_overdue({"due": "2026-10-11"}, TODAY))

    def test_days_overdue(self):
        self.assertEqual(days_overdue({"due": "2026-10-01"}, TODAY), 10)
        self.assertEqual(days_overdue({"due": "2026-12-01"}, TODAY), 0)

    def test_eta_label(self):
        self.assertEqual(eta_label({"shipped": "2026-10-09", "transit_days": 5}), "Arrives 2026-10-14")

    def test_report_header(self):
        self.assertEqual(report_header(TODAY, 42), "Daily report 2026-10-11: 42 orders")


if __name__ == "__main__":
    unittest.main()
