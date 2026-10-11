# criticality: medium
"""Row-to-object mapping for customers and products."""
import db
from utils import slugify


def get_customer(customer_id):
    conn = db.connect()
    row = conn.execute("SELECT id, name, email FROM customers WHERE id = ?", (customer_id,)).fetchone()
    return {"id": row[0], "name": row[1], "email": row[2]} if row else None


def product_slug(name):
    return slugify(name)
