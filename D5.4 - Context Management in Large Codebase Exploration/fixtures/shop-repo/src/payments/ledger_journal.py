"""Double-entry ledger writes for money movements."""
from src.payments.ledger_store import LedgerStore


class LedgerJournal:
    def __init__(self):
        self.store = LedgerStore()

    def record(self, order_id, amount_cents, memo):
        self.store.append({"order_id": order_id, "amount_cents": amount_cents, "memo": memo})
