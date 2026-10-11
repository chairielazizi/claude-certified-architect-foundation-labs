"""Append-only storage for ledger entries."""
LEDGER_TABLE = "ledger_entries"


class LedgerStore:
    def append(self, entry):
        raise NotImplementedError("database access is out of scope for the fixture")
