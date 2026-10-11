from utils import money, slugify


def test_money_rounds_to_cents():
    assert money(3.14159) == "3.14"


def test_slugify():
    assert slugify("Blue Mug") == "blue-mug"
