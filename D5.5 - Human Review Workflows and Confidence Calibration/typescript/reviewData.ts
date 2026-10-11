/**
 * Synthetic labelled extractions and calibration helpers shared by the D5.5 demos.
 *
 * Everything is pure computation on a seeded PRNG (mulberry32), implemented bit-for-bit the
 * same way in review_data.py, so the Python and TypeScript demos print identical numbers.
 * All arithmetic that reaches the output is integer arithmetic (confidence is an integer
 * 0-99, percentages are rounded half-up in integer math) to avoid float formatting drift.
 *
 * Each extraction is one field of one document:
 *   {doc_id, doc_type, field, segment, confidence, correct, layout, contradictory}
 */

/** Small seeded PRNG: the classic JS mulberry32 (Math.imul keeps every step in 32 bits). */
export class Mulberry32 {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export const VALIDATION_SEED = 2026;
export const PRODUCTION_SEED = 7;
export const VALIDATION_COUNTS: Record<string, number> = { invoice: 400, receipt: 400, contract: 100 };
export const PRODUCTION_COUNTS: Record<string, number> = { invoice: 600, receipt: 300, contract: 60 };
const TYPE_CODE: Record<string, string> = { invoice: "INV", receipt: "RCT", contract: "CTR" };

/** [field, true accuracy in per-mille]. contract.effective_date is the weak segment. */
export const FIELDS: Record<string, [string, number][]> = {
  invoice: [["vendor_name", 990], ["invoice_number", 985], ["invoice_date", 980], ["total_amount", 985]],
  receipt: [["merchant_name", 975], ["purchase_date", 980], ["total_amount", 985]],
  contract: [["party_names", 960], ["effective_date", 640], ["governing_law", 975], ["renewal_term", 950]],
};
/** Errors in this segment come with confidence as high as correct answers (ambiguous dates). */
const CONFIDENTLY_WRONG = new Set(["contract.effective_date"]);
/** Cost of an undetected error, per field (used to prioritise reviewer time). */
export const RISK: Record<string, number> = {
  total_amount: 5, effective_date: 5, party_names: 4, renewal_term: 4, invoice_number: 3,
  governing_law: 3, invoice_date: 2, purchase_date: 2, vendor_name: 2, merchant_name: 1,
};

export const TARGET_PRECISION_PCT = 99; // auto-accepted extractions must be at least this precise
export const MIN_SUPPORT = 30; // a threshold needs this many validation items above it to be trusted
const MIN_THRESHOLD = 50; // never auto-accept below this confidence, whatever the validation set says

export interface Extraction {
  doc_id: string;
  doc_type: string;
  field: string;
  segment: string;
  confidence: number;
  correct: boolean;
  layout: string;
  contradictory: boolean;
}

/** Deterministic extractions. Production batches add a new contract layout and contradictory documents. */
export function generate(seed: number, counts: Record<string, number>, production = false): Extraction[] {
  const rng = new Mulberry32(seed);
  const prefix = production ? "P-" : "V-";
  const out: Extraction[] = [];
  for (const [docType, n] of Object.entries(counts)) {
    for (let i = 1; i <= n; i++) {
      let layout = "standard";
      let contradictory = false;
      if (production) {
        if (docType === "contract" && rng.next() < 0.35) layout = "scanned_v2"; // a contract template the validation set never saw
        contradictory = rng.next() < 0.02; // e.g. two different totals in one document
      }
      for (const [field, accuracy] of FIELDS[docType]) {
        const segment = `${docType}.${field}`;
        const novel = production && layout === "scanned_v2" && field === "governing_law";
        const correct = rng.next() * 1000 < (novel ? 400 : accuracy);
        let confidence: number;
        if (correct) confidence = 60 + Math.floor(Math.max(rng.next(), rng.next()) * 40);
        else if (novel) confidence = 85 + Math.floor(rng.next() * 15); // new failure mode, confidently wrong
        else if (CONFIDENTLY_WRONG.has(segment)) confidence = 60 + Math.floor(rng.next() * 40);
        else confidence = 35 + Math.floor(rng.next() * 50);
        out.push({
          doc_id: `${prefix}${TYPE_CODE[docType]}-${String(i).padStart(4, "0")}`,
          doc_type: docType,
          field,
          segment,
          confidence,
          correct,
          layout,
          contradictory,
        });
      }
    }
  }
  return out;
}

/** n/d as a percentage with one decimal, rounded half-up in integer math (identical in Python). */
export function pct(n: number, d: number): string {
  if (d === 0) return "-";
  const tenths = Math.floor((n * 2000 + d) / (2 * d));
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** A checksum to confirm the Python and TypeScript generators agree. */
export function fingerprint(items: Extraction[]): string {
  let total = 0;
  items.forEach((x, idx) => {
    total = (total * 31 + (idx + 1) * (x.confidence + 1) * (x.correct ? 2 : 1)) % 1_000_000_007;
  });
  return `${items.length} extractions, ${items.filter((x) => x.correct).length} correct, checksum ${total}`;
}

export function segments(items: Extraction[]): Map<string, Extraction[]> {
  const out = new Map<string, Extraction[]>();
  for (const x of items) {
    const group = out.get(x.segment) ?? [];
    group.push(x);
    out.set(x.segment, group);
  }
  return out;
}

export interface Calibration {
  threshold: number;
  correct: number;
  accepted: number;
  total: number;
}

/** Lowest confidence threshold whose auto-accepted set meets the precision target. */
export function calibrate(items: Extraction[]): Calibration | null {
  for (let threshold = MIN_THRESHOLD; threshold < 100; threshold++) {
    const above = items.filter((x) => x.confidence >= threshold);
    if (above.length < MIN_SUPPORT) return null; // higher thresholds only have fewer items
    const correct = above.filter((x) => x.correct).length;
    if (correct * 100 >= TARGET_PRECISION_PCT * above.length) return { threshold, correct, accepted: above.length, total: items.length };
  }
  return null;
}

export function calibrateAll(items: Extraction[]): Map<string, Calibration | null> {
  const out = new Map<string, Calibration | null>();
  for (const [segment, group] of segments(items)) out.set(segment, calibrate(group));
  return out;
}

export function precisionAt(items: Extraction[], threshold: number): [number, number] {
  const above = items.filter((x) => x.confidence >= threshold);
  return [above.filter((x) => x.correct).length, above.length];
}

export const REVIEW_CAPACITY = 120; // extractions the review team can check per batch
export const SAMPLE_SEED = 99;
export const PER_STRATUM = 50; // stratified audit sample per document type
export const PATTERN_MIN_ERRORS = 3; // sampled errors in one (segment, layout) cluster that trigger an alert

export interface QueueItem extends Extraction {
  reason: string;
  priority: number;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Split into auto-accepted and a human queue ordered by risk x uncertainty. */
export function route(items: Extraction[], thresholds: Map<string, Calibration | null>): { auto: Extraction[]; queue: QueueItem[] } {
  const auto: Extraction[] = [];
  const queue: QueueItem[] = [];
  for (const x of items) {
    const calibrated = thresholds.get(x.segment) ?? null;
    let reason: string;
    if (x.contradictory) reason = "contradictory source";
    else if (calibrated === null) reason = "segment below the accuracy bar";
    else if (x.confidence < calibrated.threshold) reason = "low confidence";
    else {
      auto.push(x);
      continue;
    }
    // A contradictory source makes the model's confidence meaningless: treat it as fully uncertain.
    const uncertainty = x.contradictory ? 100 : 100 - x.confidence;
    queue.push({ ...x, reason, priority: RISK[x.field] * uncertainty });
  }
  queue.sort((a, b) => b.priority - a.priority || cmp(a.doc_id, b.doc_id) || cmp(a.field, b.field));
  return { auto, queue };
}

/** Partial Fisher-Yates shuffle driven by the shared PRNG. */
export function sampleWithoutReplacement<T>(items: T[], k: number, rng: Mulberry32): T[] {
  const pool = [...items];
  const n = Math.min(k, pool.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng.next() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, n);
}
