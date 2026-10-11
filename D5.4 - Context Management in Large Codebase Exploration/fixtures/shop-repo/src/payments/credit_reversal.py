"""Orchestrates a refund ("credit reversal") end to end."""
from src.notifications.refund_notifier import RefundNotifier
from src.orders.order_store import OrderStore
from src.payments.acmepay_client import AcmePayClient
from src.payments.ledger_journal import LedgerJournal
from src.policies.eligibility_gate import ReturnEligibilityGate


class CreditReversalService:
    def __init__(self):
        self.orders = OrderStore()
        self.gate = ReturnEligibilityGate()
        self.psp = AcmePayClient()
        self.ledger = LedgerJournal()
        self.notifier = RefundNotifier()

    def reverse(self, order_id, reason):
        order = self.orders.get(order_id)
        self.gate.check(order)
        charge = self.psp.refund(order.charge_id, order.total_cents)
        self.ledger.record(order_id, -order.total_cents, reason)
        self.notifier.send(order, charge)
        return charge
