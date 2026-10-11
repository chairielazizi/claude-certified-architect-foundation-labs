"""Promotional pricing rules."""
MAX_DISCOUNT_PERCENT = 40


class PricingRules:
    def price_for(self, product, customer):
        raise NotImplementedError("pricing engine is out of scope for the fixture")
