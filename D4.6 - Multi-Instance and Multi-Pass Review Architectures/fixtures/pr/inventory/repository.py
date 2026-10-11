import logging

log = logging.getLogger(__name__)


class StockRepository:
    def __init__(self, db):
        self.db = db

    def adjust_stock(self, sku: str, delta: int) -> None:
        try:
            self.db.execute("UPDATE stock SET on_hand = on_hand + ? WHERE sku = ?", (delta, sku))
        except Exception:
            log.warning("adjust_stock failed for %s", sku)

    def get(self, sku: str):
        return self.db.fetch_one("SELECT sku, on_hand, reserved FROM stock WHERE sku = ?", (sku,))
