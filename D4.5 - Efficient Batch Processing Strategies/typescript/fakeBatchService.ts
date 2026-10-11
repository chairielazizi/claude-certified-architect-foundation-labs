/**
 * Offline stand-in for client.messages.batches (D4.5), on a simulated clock.
 *
 * Same surface as the SDK: create({requests: [{custom_id, params}]}) -> batch with .id and
 * .processing_status; retrieve(id) -> "in_progress" until the simulated processing time has
 * passed, then "ended"; results(id) -> one entry per request with .custom_id and .result.type
 * in succeeded | errored | expired.
 *
 * What it simulates, all from a seeded PRNG so every run is identical (and identical to the
 * Python lab):
 *  - results come back in SHUFFLED order (the real API makes no ordering promise)
 *  - requests over the context limit error with invalid_request_error
 *  - a chosen number of requests expire (the real API expires what is unfinished at 24h)
 *  - processing takes 0.5-3.5 simulated hours per batch (real: usually < 1h, max 24h)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

// Scaled down from the real 1M-token window so the oversized document stays a small fixture.
export const FAKE_CONTEXT_LIMIT_TOKENS = 6_000;

/** Tiny seeded PRNG with an identical Python implementation, so both labs match. */
export class Mulberry32 {
  private state: number;
  constructor(seed: number) {
    this.state = seed | 0;
  }
  random(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  shuffle<T>(items: T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

export class SimClock {
  hours = 0;
  advance(hours: number): void {
    this.hours += hours;
  }
}

// Minimal shapes shared by the fake and the real SDK objects (the real ones have more fields).
export interface BatchRequest {
  custom_id: string;
  params: lab.CreateParams;
}

export interface BatchStatus {
  id: string;
  processing_status: string;
  request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  created_at: number | string;
  ended_at: number | string | null;
}

export interface BatchResult {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "canceled" | "expired";
    message?: Anthropic.Message;
    error?: { type: string; error: { type: string; message: string } };
  };
}

export interface BatchesLike {
  create(body: { requests: BatchRequest[] }): Promise<BatchStatus>;
  retrieve(id: string): Promise<BatchStatus>;
  results(id: string): Promise<BatchResult[]>;
}

export function approxTokens(params: lab.CreateParams): number {
  const text = params.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("");
  const system = typeof params.system === "string" ? params.system : "";
  return Math.floor((text.length + system.length) / 4);
}

interface StoredBatch {
  requests: BatchRequest[];
  createdAt: number;
  endsAt: number;
  expired: Set<string>;
  results: BatchResult[] | null;
}

export class FakeBatchService implements BatchesLike {
  private rng: Mulberry32;
  private expirations: number[];
  private batches = new Map<string, StoredBatch>();
  private nextId = 1;
  readonly created: string[][] = []; // custom_ids per create(), for inspection

  constructor(
    private responder: (params: lab.CreateParams) => Anthropic.Message,
    private clock: SimClock,
    seed = 7,
    expirationsPerBatch: number[] = [],
  ) {
    this.rng = new Mulberry32(seed);
    this.expirations = [...expirationsPerBatch];
  }

  async create(body: { requests: BatchRequest[] }): Promise<BatchStatus> {
    const ids = body.requests.map((r) => r.custom_id);
    if (new Set(ids).size !== ids.length) throw new Error("custom_id values must be unique within a batch");
    const batchId = `msgbatch_fake_${String(this.nextId++).padStart(3, "0")}`;
    const hours = 0.5 + this.rng.random() * 3.0;
    const fits = body.requests.filter((r) => approxTokens(r.params) <= FAKE_CONTEXT_LIMIT_TOKENS).map((r) => r.custom_id);
    const expireN = this.expirations.length ? (this.expirations.shift() as number) : 0;
    const expired = new Set(this.rng.shuffle(fits).slice(0, expireN));
    this.batches.set(batchId, { requests: body.requests, createdAt: this.clock.hours, endsAt: this.clock.hours + hours, expired, results: null });
    this.created.push(ids);
    return this.retrieve(batchId);
  }

  async retrieve(batchId: string): Promise<BatchStatus> {
    const b = this.get(batchId);
    const ended = this.clock.hours >= b.endsAt;
    const counts = { processing: b.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    if (ended) {
      for (const r of this.computeResults(b)) counts[r.result.type] += 1;
      counts.processing = 0;
    }
    return {
      id: batchId,
      processing_status: ended ? "ended" : "in_progress",
      request_counts: counts,
      created_at: b.createdAt,
      ended_at: ended ? b.endsAt : null,
    };
  }

  async results(batchId: string): Promise<BatchResult[]> {
    if ((await this.retrieve(batchId)).processing_status !== "ended") {
      throw new Error("results are only available once processing_status == 'ended'");
    }
    return this.computeResults(this.get(batchId));
  }

  private get(batchId: string): StoredBatch {
    const b = this.batches.get(batchId);
    if (!b) throw new Error(`no batch ${batchId}`);
    return b;
  }

  private computeResults(b: StoredBatch): BatchResult[] {
    if (b.results === null) {
      const out = b.requests.map((req): BatchResult => {
        const tokens = approxTokens(req.params);
        if (tokens > FAKE_CONTEXT_LIMIT_TOKENS) {
          const error = { type: "invalid_request_error", message: `prompt is too long: ${tokens} tokens > ${FAKE_CONTEXT_LIMIT_TOKENS} maximum` };
          return { custom_id: req.custom_id, result: { type: "errored", error: { type: "error", error } } };
        }
        if (b.expired.has(req.custom_id)) return { custom_id: req.custom_id, result: { type: "expired" } };
        return { custom_id: req.custom_id, result: { type: "succeeded", message: this.responder(req.params) } };
      });
      b.results = this.rng.shuffle(out); // no ordering guarantee: correlate by custom_id
    }
    return b.results;
  }
}
