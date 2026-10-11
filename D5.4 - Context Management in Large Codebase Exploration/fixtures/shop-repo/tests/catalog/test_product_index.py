from src.catalog.product_index import ProductIndex


def test_search_respects_limit(index_fixture):
    assert len(ProductIndex().search("headphones", limit=3)) <= 3
