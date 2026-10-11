import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { addMinor, formatMoney } from "./money.ts";

describe("addMinor", () => {
  it("sums integer minor-unit amounts", () => {
    assert.equal(addMinor(1999, 1, 500), 2500);
  });

  it("rejects a fractional amount", () => {
    assert.throws(() => addMinor(19.99), RangeError);
  });
});

describe("formatMoney", () => {
  const cases: Array<[number, string]> = [
    [1999, "USD 19.99"],
    [5, "USD 0.05"],
    [-250, "USD -2.50"],
  ];
  for (const [amountMinor, expected] of cases) {
    it(`formats ${amountMinor} as ${expected}`, () => {
      assert.equal(formatMoney(amountMinor, "USD"), expected);
    });
  }
});
