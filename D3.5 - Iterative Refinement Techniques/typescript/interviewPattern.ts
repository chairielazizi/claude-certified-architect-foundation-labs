/**
 * D3.5 - The interview pattern: have Claude ask questions before it implements.
 *
 * Telling Claude to interview you first surfaces the considerations you didn't know to mention (for a
 * cache: invalidation, failure modes, where stale data is unacceptable). Without it, Claude writes the
 * obvious cache, which here never invalidates and would serve a stale price at checkout.
 *
 * Run:  npx tsx interviewPattern.ts          (offline: scripted transcript)
 *       npx tsx interviewPattern.ts --live   (real Claude; the developer's answers are still scripted)
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

const TASK =
  "Add caching to the product pricing service. get_price(sku, currency) hits Postgres on every call and " +
  "p95 latency on product pages is 180ms.";

const INTERVIEW_SYSTEM =
  "You are a senior engineer pairing with a developer who is new to this domain. Before writing any code, " +
  "interview them: ask at most 5 numbered questions about considerations they may not have anticipated - " +
  "cache invalidation strategy, failure modes, consistency requirements, key design and expiry, and how " +
  "success is measured. Ask only questions whose answers would change the design. Do not write code until " +
  "they have answered; then summarize the decisions their answers imply and implement.";
const PLAIN_SYSTEM = "You are a senior engineer. Implement what the developer asks.";

const ANSWERS = [
  "1. Prices change in the admin tool, which publishes a PriceChanged event. A change must be visible within a minute.",
  "2. If the cache is down, read from Postgres. A price lookup must never fail because of the cache.",
  "3. Checkout must always use the live price. Product pages may be up to a minute stale.",
  "4. About 40k SKUs; prices are per currency.",
  "5. Success means p95 under 20ms on product pages.",
].join("\n");

// ---------------------------------------------------------------------------
// Offline stand-in for Claude: behaves according to its system prompt and the conversation so far
// ---------------------------------------------------------------------------

const QUESTIONS = [
  "Before I write anything, a few questions whose answers change the design:",
  "1. Invalidation: how do prices change (admin tool, batch import, external feed), and how quickly must a change be visible?",
  "2. Failure modes: if the cache is slow or down, should lookups fail, or fall back to Postgres?",
  "3. Consistency: is any path allowed to show a stale price - product pages, cart, checkout?",
  "4. Keys: roughly how many SKUs, and do prices vary by currency, region or customer tier?",
  "5. Success: what latency target are we aiming for, and where is it measured?",
].join("\n");

const DESIGN = [
  "Decisions from your answers:",
  '- Invalidation: subscribe to PriceChanged and delete price:{sku}:{currency} (cache-aside); a 60s TTL is the safety net for "visible within a minute".',
  "- Failure mode: cache errors are logged and the lookup falls back to Postgres (fail open), with a 50ms cache timeout so a slow cache cannot add latency.",
  "- Consistency: checkout calls get_live_price() and bypasses the cache; product pages use the cached path.",
  "- Keys: price:{sku}:{currency}; ~40k SKUs x currencies is small enough to keep warm.",
  "- Success: p95 < 20ms on product pages; emit hit/miss/fallback counters to verify it.",
  "",
  "```python",
  "def get_price(sku, currency):",
  '    key = f"price:{sku}:{currency}"',
  "    try:",
  "        cached = cache.get(key, timeout_ms=50)",
  "        if cached is not None:",
  "            return cached",
  "    except CacheError:",
  '        metrics.incr("price_cache.fallback")',
  "        return db.fetch_price(sku, currency)",
  "    price = db.fetch_price(sku, currency)",
  "    cache.set(key, price, ttl_s=60)",
  "    return price",
  "",
  "",
  "def on_price_changed(event):",
  '    cache.delete(f"price:{event.sku}:{event.currency}")',
  "",
  "",
  "def get_live_price(sku, currency):  # checkout path: never cached",
  "    return db.fetch_price(sku, currency)",
  "```",
].join("\n");

const NAIVE = [
  "Here is a cached version:",
  "",
  "```python",
  "from functools import lru_cache",
  "",
  "",
  "@lru_cache(maxsize=50_000)",
  "def get_price(sku, currency):",
  "    return db.fetch_price(sku, currency)",
  "```",
  "",
  "Repeat lookups no longer touch the database.",
].join("\n");

function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const interviewing = lab.systemText(params).toLowerCase().includes("interview");
  const firstTurn = params.messages.length === 1;
  if (interviewing && firstTurn) return lab.message([lab.text(QUESTIONS)]);
  if (interviewing) return lab.message([lab.text(DESIGN)]);
  return lab.message([lab.text(NAIVE)]);
}

async function ask(client: lab.MessagesClient, system: string, messages: Anthropic.MessageParam[]): Promise<string> {
  const response = await client.messages.create({ model: lab.MODEL, max_tokens: 16000, system, messages });
  messages.push({ role: "assistant", content: response.content });
  return lab.textOf(response);
}

const indent = (prefix: string, text: string) => text.split("\n").map((line) => prefix + line).join("\n");

lab.banner("D3.5  Interview pattern: questions first, then implementation");
const client = lab.getClient(scriptedModel);

lab.section("A. Without the interview instruction");
const naive = await ask(client, PLAIN_SYSTEM, [{ role: "user", content: TASK }]);
console.log(indent("  claude> ", naive));

lab.section("B. With the interview instruction");
const convo: Anthropic.MessageParam[] = [{ role: "user", content: TASK }];
const questions = await ask(client, INTERVIEW_SYSTEM, convo);
console.log(indent("  claude> ", questions));
convo.push({ role: "user", content: ANSWERS });
console.log(indent("  dev>    ", ANSWERS));
const design = await ask(client, INTERVIEW_SYSTEM, convo);
console.log(indent("  claude> ", design));

lab.section("Checks");
lab.check(convo.length === 4 && convo[3].role === "assistant", "interview flow: task -> questions -> answers -> design");
if (!lab.isLive()) {
  lab.check(!questions.includes("```") && (questions.match(/\?/g) ?? []).length >= 3, "first reply asks questions and writes no code");
  const topics = ["invalidat", "down", "stale"].filter((w) => questions.toLowerCase().includes(w));
  lab.check(topics.length === 3, "the questions cover invalidation, failure modes and consistency");
  lab.check(
    ["PriceChanged", "falls back to Postgres", "checkout calls get_live_price()"].every((s) => design.includes(s)),
    "the design applies each answer: event invalidation, fail-open fallback, live price at checkout",
  );
  lab.check(naive.includes("```") && !naive.toLowerCase().includes("invalidat"), "without the interview: immediate code that never invalidates (stale prices, even at checkout)");
}
