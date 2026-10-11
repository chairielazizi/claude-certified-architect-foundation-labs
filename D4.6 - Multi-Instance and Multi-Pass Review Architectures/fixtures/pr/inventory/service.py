from inventory.events import publish
from inventory.repository import StockRepository


class StockService:
    def __init__(self, repo: StockRepository):
        self.repo = repo

    def receive(self, item, qty: int) -> None:
        self.repo.adjust_stock(qty, item.sku)
        publish("stock.received", {"sku": item.sku, "qty": qty})

    def reserve(self, item, qty: int) -> bool:
        available = item.on_hand - item.reserved
        if qty > available:
            return False
        item.reserved += qty
        return True
