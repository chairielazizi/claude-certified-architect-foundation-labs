/** Sum integer minor-unit amounts; rejects fractional values so float money never sneaks in. */
export function addMinor(...amounts: number[]): number {
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) throw new RangeError(`Not an integer minor-unit amount: ${amount}`);
  }
  return amounts.reduce((sum, amount) => sum + amount, 0);
}

/** Format minor units for display, e.g. formatMoney(1999, "USD") -> "USD 19.99". */
export function formatMoney(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  return `${currency} ${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
