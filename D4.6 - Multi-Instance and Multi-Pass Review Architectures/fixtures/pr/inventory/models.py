from dataclasses import dataclass


@dataclass
class StockItem:
    sku: str
    on_hand: int  # units
    reserved: int  # units
