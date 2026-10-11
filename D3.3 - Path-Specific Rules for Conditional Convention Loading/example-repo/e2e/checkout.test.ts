import { describe, it } from "node:test";
import assert from "node:assert/strict";

const BASE_URL = process.env.E2E_BASE_URL;

describe("checkout (end to end)", { skip: !BASE_URL }, () => {
  it("returns the total of a seeded order", async () => {
    const response = await fetch(`${BASE_URL}/orders/ord_seed1/total`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { totalMinor: number; currency: string };
    assert.equal(body.currency, "USD");
    assert.ok(Number.isInteger(body.totalMinor));
  });
});
