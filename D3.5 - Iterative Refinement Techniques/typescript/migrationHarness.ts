/**
 * Run migrationTests.ts against a candidate implementation and print the results as JSON.
 *
 * Executed in a SUBPROCESS (node tsx/cli.mjs migrationHarness.ts <candidate.ts>) by
 * testDrivenIteration.ts. Model-written code is only ever imported here, in a separate process
 * with a timeout, never inside the lab's own process.
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { BASE, CASES, COUNTRIES, PERF, type LegacyRecord } from "./migrationTests.ts";

interface Candidate {
  migrateCustomer: (record: LegacyRecord, countries: Record<string, string>) => unknown;
  migrateAll: (records: LegacyRecord[], loadCountries: () => Record<string, string>) => unknown[];
}

interface Result {
  name: string;
  input: unknown;
  expected: unknown;
  actual: unknown;
  error?: string;
  passed: boolean;
}

const errorText = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

async function loadCandidate(file: string): Promise<Candidate | null> {
  try {
    return (await import(pathToFileURL(file).href)) as Candidate;
  } catch (err) {
    console.log(JSON.stringify({ import_error: errorText(err), results: [] })); // the candidate does not even import
    return null;
  }
}

function runSuite(candidate: Candidate): Result[] {
  const results: Result[] = [];
  for (const test of CASES) {
    try {
      const actual = candidate.migrateCustomer(JSON.parse(JSON.stringify(test.input)) as LegacyRecord, { ...COUNTRIES });
      results.push({ name: test.name, input: test.input, expected: test.expected, actual, passed: isDeepStrictEqual(actual, test.expected) });
    } catch (err) {
      results.push({ name: test.name, input: test.input, expected: test.expected, actual: null, error: errorText(err), passed: false });
    }
  }

  let loads = 0;
  const loadCountries = () => {
    loads++;
    return { ...COUNTRIES };
  };
  const records: LegacyRecord[] = Array.from({ length: PERF.records }, (_, i) => ({ ...BASE, id: String(i) }));
  const perfExpected = `<= ${PERF.maxLoads} table load(s), < ${PERF.maxSeconds}s`;
  try {
    const start = performance.now();
    const out = candidate.migrateAll(records, loadCountries);
    const elapsed = (performance.now() - start) / 1000;
    results.push({
      name: PERF.name,
      input: `${PERF.records} records`,
      expected: perfExpected,
      actual: `${loads} table load(s), ${elapsed.toFixed(2)}s, ${out.length} records`,
      passed: loads <= PERF.maxLoads && elapsed < PERF.maxSeconds && out.length === PERF.records,
    });
  } catch (err) {
    results.push({ name: PERF.name, input: `${PERF.records} records`, expected: perfExpected, actual: null, error: errorText(err), passed: false });
  }
  return results;
}

const candidate = await loadCandidate(String(process.argv[2]));
if (candidate) console.log(JSON.stringify({ results: runSuite(candidate) }));
