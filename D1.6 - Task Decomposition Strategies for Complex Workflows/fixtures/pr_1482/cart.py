"""Shopping cart persistence."""
import json

_STORE = {}


class Cart:
    def __init__(self, cart_id, items):
        self.cart_id = cart_id
        self.items = items

    @classmethod
    def load(cls, cart_id):
        return cls(cart_id, json.loads(_STORE.get(cart_id, "[]")))

    def remove(self, index):
        if index <= len(self.items):
            del self.items[index]
