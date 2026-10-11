# criticality: high
"""Database connection helpers for the shop (sqlite)."""
import sqlite3

DB_PATH = "shop.db"


def connect():
    return sqlite3.connect(DB_PATH)


def fetch_one(sql, params=()):
    with connect() as conn:
        return conn.execute(sql, params).fetchone()
