"""Search index for the product catalog."""
INDEX_NAME = "products_v4"


class ProductIndex:
    def search(self, text, limit=20):
        raise NotImplementedError("search backend is out of scope for the fixture")
