/**
 * The test suite for the customer-record migration, written BEFORE any implementation exists.
 *
 *   migrateCustomer(record, countries) -> v2 record
 *   migrateAll(records, loadCountries) -> v2 records; loadCountries() is an expensive lookup (a DB round trip)
 *
 * v1: { id: "17", name: " Ada Lovelace ", email: "ADA@Example.COM", phone: "(555) 010-2233",
 *       signup: "03/14/2019" | "2019-03-14", balance: "1,204.35", country: "uk" }
 * v2: { id: 17, full_name: "Ada Lovelace", email: "ada@example.com", phone: "+15550102233",
 *       signup_date: "2019-03-14", balance_cents: 120435, country: "GB" }
 *
 * Legacy data is dirty: any field except id may be null or missing entirely. Data only, so the same
 * cases can be shown to Claude verbatim and run by the harness.
 */

export type LegacyRecord = Record<string, string | null>;
export type MigratedRecord = Record<string, string | number | null>;

export interface TestCase {
  name: string;
  input: LegacyRecord;
  expected: MigratedRecord;
}

export const COUNTRIES: Record<string, string> = { uk: "GB", usa: "US", de: "DE" };

export const BASE: LegacyRecord = {
  id: "17",
  name: " Ada Lovelace ",
  email: "ADA@Example.COM",
  phone: "(555) 010-2233",
  signup: "2019-03-14",
  balance: "12.50",
  country: "uk",
};

const BASE_OUT: MigratedRecord = {
  id: 17,
  full_name: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+15550102233",
  signup_date: "2019-03-14",
  balance_cents: 1250,
  country: "GB",
};

function testCase(name: string, changes: LegacyRecord, expectedChanges: MigratedRecord, drop: string[] = []): TestCase {
  const input: LegacyRecord = {};
  for (const [key, value] of Object.entries({ ...BASE, ...changes })) if (!drop.includes(key)) input[key] = value;
  return { name, input, expected: { ...BASE_OUT, ...expectedChanges } };
}

export const CASES: TestCase[] = [
  // expected behavior
  testCase("migrates a complete record", {}, {}),
  testCase("trims the name and lowercases the email", { name: "  Grace Hopper ", email: " Grace@Navy.MIL " }, { full_name: "Grace Hopper", email: "grace@navy.mil" }),
  testCase("converts the legacy MM/DD/YYYY signup date to ISO", { signup: "03/14/2019" }, {}),
  testCase("parses a balance with a thousands separator exactly", { balance: "1,204.35" }, { balance_cents: 120435 }),
  testCase("maps the country through the lookup table", { country: "usa" }, { country: "US" }),
  // edge cases: null and missing values
  testCase("keeps a null phone as null", { phone: null }, { phone: null }),
  testCase("treats a missing email as null", {}, { email: null }, ["email"]),
  testCase("treats a null balance as zero cents", { balance: null }, { balance_cents: 0 }),
  testCase("keeps a null signup date as null", { signup: null }, { signup_date: null }),
  testCase("leaves an unknown country as null", { country: "atlantis" }, { country: null }),
];

// Performance requirement: a 20k-record batch looks the country table up ONCE and finishes quickly.
export const PERF = { name: "migrateAll loads the country table once for 20,000 records", records: 20_000, maxLoads: 1, maxSeconds: 2.0 };
