import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApiError, getOrderTotal, type Order, type OrderRepository } from "./orders.ts";

const repoWith = (orders: Record<string, Order>): OrderRepository => ({
  findById: async (id) => orders[id] ?? null,
});

const order: Order = {
  id: "ord_1",
  currency: "USD",
  lines: [
    { sku: "mug", quantity: 2, unitPriceMinor: 1250 },
    { sku: "tee", quantity: 1, unitPriceMinor: 1999 },
  ],
};

describe("getOrderTotal", () => {
  it("sums line totals in minor units", async () => {
    const total = await getOrderTotal(repoWith({ ord_1: order }), "ord_1");
    assert.deepEqual(total, { orderId: "ord_1", totalMinor: 4499, currency: "USD" });
  });

  it("returns 404 ORDER_NOT_FOUND for an unknown order", async () => {
    await assert.rejects(getOrderTotal(repoWith({}), "ord_missing"), (err: unknown) => err instanceof ApiError && err.code === "ORDER_NOT_FOUND");
  });

  it("maps a store outage to a retryable 503", async () => {
    const down: OrderRepository = { findById: async () => Promise.reject(new Error("connection reset")) };
    await assert.rejects(getOrderTotal(down, "ord_1"), (err: unknown) => err instanceof ApiError && err.status === 503 && err.retryable);
  });
});
