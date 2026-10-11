from inventory.service import StockService


def post_receive(service: StockService, item, body: dict):
    qty = int(body["qty"])
    service.receive(item, qty)
    return {"ok": True}


def post_reserve(service: StockService, item, body: dict):
    qty = int(body["qty"])
    if service.reserve(item, qty):
        return {"ok": True}
    return {"ok": False, "error": "insufficient stock"}
