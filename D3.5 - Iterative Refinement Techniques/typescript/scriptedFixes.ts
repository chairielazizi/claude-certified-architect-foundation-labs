/**
 * Offline stand-in for Claude in the test-driven iteration demo (TypeScript candidates).
 *
 * Driven by the prompt, as the real model is: no failures listed -> first attempt; failures listed ->
 * a revision addressing them. Revision 2 fixes every listed failure but parses money through floats
 * (Math.trunc(1204.35 * 100) === 120434), and the next test run catches it.
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

export const FIRST_ATTEMPT = [
  "export function migrateCustomer(record: any, countries: Record<string, string>) {",
  "  return {",
  "    id: parseInt(record.id, 10),",
  "    full_name: record.name.trim(),",
  "    email: record.email.trim().toLowerCase(),",
  '    phone: "+1" + record.phone.replace(/\\D/g, ""),',
  "    signup_date: record.signup.slice(0, 10),",
  "    balance_cents: Math.trunc(parseFloat(record.balance) * 100),",
  "    country: countries[record.country],",
  "  };",
  "}",
  "",
  "export function migrateAll(records: any[], loadCountries: () => Record<string, string>) {",
  "  return records.map((record) => migrateCustomer(record, loadCountries()));",
  "}",
  "",
].join("\n");

const SECOND_HELPERS = [
  "function clean(value: unknown): string | null {",
  "  if (value === null || value === undefined) return null;",
  "  const text = String(value).trim();",
  '  return text === "" ? null : text;',
  "}",
  "",
  "function phone(raw: unknown): string | null {",
  "  const text = clean(raw);",
  "  if (text === null) return null;",
  '  const digits = text.replace(/\\D/g, "");',
  '  return "+" + (digits.length === 10 ? "1" + digits : digits);',
  "}",
  "",
  "function isoDate(raw: unknown): string | null {",
  "  const text = clean(raw);",
  "  if (text === null) return null;",
  "  const us = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(text);",
  '  if (us) return us[3] + "-" + us[1] + "-" + us[2];',
  "  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(text)) return text;",
  '  throw new Error("Unrecognized date: " + text);',
  "}",
  "",
].join("\n");

const FLOAT_CENTS = [
  "function cents(raw: unknown): number {",
  "  const text = clean(raw);",
  '  return text === null ? 0 : Math.trunc(parseFloat(text.replace(/,/g, "")) * 100);',
  "}",
  "",
].join("\n");

const EXACT_CENTS = [
  "function cents(raw: unknown): number {",
  "  // exact string arithmetic for money: no floating point anywhere",
  "  const text = clean(raw);",
  "  if (text === null) return 0;",
  '  const match = /^(-?)(\\d+)(?:\\.(\\d{1,2}))?$/.exec(text.replace(/,/g, ""));',
  '  if (!match) throw new Error("Unrecognized amount: " + text);',
  '  const value = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));',
  "  return match[1] ? -value : value;",
  "}",
  "",
].join("\n");

const SECOND_EXPORTS = [
  "export function migrateCustomer(record: Record<string, unknown>, countries: Record<string, string>) {",
  "  const email = clean(record.email);",
  "  const country = clean(record.country);",
  "  return {",
  "    id: parseInt(String(record.id), 10),",
  "    full_name: clean(record.name),",
  "    email: email ? email.toLowerCase() : null,",
  "    phone: phone(record.phone),",
  "    signup_date: isoDate(record.signup),",
  "    balance_cents: cents(record.balance),",
  "    country: country ? (countries[country.toLowerCase()] ?? null) : null,",
  "  };",
  "}",
  "",
  "export function migrateAll(records: Record<string, unknown>[], loadCountries: () => Record<string, string>) {",
  "  const countries = loadCountries(); // one database round trip per batch, not per record",
  "  return records.map((record) => migrateCustomer(record, countries));",
  "}",
  "",
].join("\n");

export const SECOND_ATTEMPT = SECOND_HELPERS + FLOAT_CENTS + "\n" + SECOND_EXPORTS;
export const THIRD_ATTEMPT = SECOND_HELPERS + EXACT_CENTS + "\n" + SECOND_EXPORTS;
export const MONEY_TEST = "parses a balance with a thousands separator exactly";

/** Names of the failing tests listed in a fix prompt. */
export function failingTests(prompt: string): string[] {
  const section = prompt.includes("Failing tests:") ? prompt.split("Failing tests:")[1] : "";
  return [...section.matchAll(/^- (.+)$/gm)].map((m) => m[1]);
}

export function scriptedClaude(params: lab.CreateParams): Anthropic.Message {
  const failures = failingTests(lab.lastUserText(params));
  let code: string;
  let note: string;
  if (!failures.length) {
    [code, note] = [FIRST_ATTEMPT, "First implementation of migrateCustomer and migrateAll."];
  } else if (failures.length === 1 && failures[0] === MONEY_TEST) {
    [code, note] = [THIRD_ATTEMPT, "Parse money with exact string arithmetic so 1,204.35 becomes exactly 120435 cents."];
  } else {
    [code, note] = [SECOND_ATTEMPT, "Handled null/missing fields, MM/DD/YYYY dates, thousands separators and unknown countries; load the country table once per batch."];
  }
  return lab.message([lab.text("```typescript\n" + code + "```\n\n" + note)]);
}
