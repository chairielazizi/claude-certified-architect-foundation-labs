// Money helpers for the payments package. Amounts are integer minor units (see CLAUDE.md).

const MINOR_UNITS: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, JPY: 0 };

/** Convert a decimal string such as "19.99" into integer minor units for `currency`. */
export function toMinorUnits(amount: string, currency: string): number {
  const digits = MINOR_UNITS[currency];
  if (digits === undefined) throw new Error(`Unsupported currency ${currency}`);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`Invalid amount ${amount}`);
  const fraction = (match[2] ?? "").padEnd(digits, "0");
  if (fraction.length > digits) throw new Error(`Too many decimal places in ${amount}`);
  return Number(match[1]) * 10 ** digits + Number(fraction || "0");
}
