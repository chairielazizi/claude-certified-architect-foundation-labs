from inventory.events import subscribe

received_today = []


def on_received(event):
    received_today.append((event["sku"], event["quantity"]))


subscribe("stock.received", on_received)


def low_stock(items, threshold=5):
    return [i.sku for i in items if i.on_hand - i.reserved < threshold]
