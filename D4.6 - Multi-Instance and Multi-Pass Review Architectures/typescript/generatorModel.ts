/**
 * Prompts and the offline model for D4.6's generator / self-review / independent-review demo.
 *
 * The generator writes paginate() with a subtle off-by-one (pages are 1-based, the code treats
 * them as 0-based) and explains its design in the same turn. The offline model then behaves the
 * way the exam describes:
 *  - reviewing in the SAME conversation, it reads the code through its own design notes ("page
 *    maps directly to an offset") and finds the code consistent with them - even when told to
 *    "think very carefully and question every assumption"
 *  - as an INDEPENDENT reviewer with only the spec and the code, it checks the code against the
 *    spec ("1-based") and catches the bug
 */
import Anthropic from "@anthropic-ai/sdk";
import * as lab from "../../shared/typescript/labkit.ts";

export const TASK =
  "Write a Python function paginate(items, page, page_size) for our REST API. Pages are 1-based: " +
  "page=1 returns the first page_size items. Pages past the end return [].";
export const GENERATOR_SYSTEM = "You are a senior Python developer. Explain your design briefly, then give the code in a ```python block.";
const REVIEW_FORMAT = 'Respond with JSON only: {"findings": [{"issue": str, "severity": "low|medium|high", "confidence": 0-1}]}.';
export const SELF_REVIEW = `Now review the code you just wrote for bugs. ${REVIEW_FORMAT}`;
export const SELF_REVIEW_HARDER = `Review it again. Think very carefully and question every assumption you made. ${REVIEW_FORMAT}`;
export const REVIEWER_SYSTEM = `You are a code reviewer. Check the code strictly against the specification. ${REVIEW_FORMAT}`;

const GENERATED =
  "Design notes: the page number maps directly to an offset, so the slice starts at\n" +
  "page * page_size and is page_size long. Slicing past the end of a list returns [] in Python,\n" +
  "which covers the out-of-range case without a branch.\n\n" +
  "```python\n" +
  "def paginate(items, page, page_size):\n" +
  "    start = page * page_size\n" +
  "    return items[start:start + page_size]\n" +
  "```";

function contentText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export function scriptedModel(params: lab.CreateParams): Anthropic.Message {
  const messages = params.messages;
  const ownReasoning = messages.some((m) => m.role === "assistant" && contentText(m.content).includes("Design notes"));

  if (messages.length === 1 && lab.systemText(params) === GENERATOR_SYSTEM) return lab.message([lab.text(GENERATED)]);

  if (ownReasoning) {
    // Same session: the code is judged against the model's own stated design, which it matches.
    return lab.message([
      lab.text(
        JSON.stringify({
          findings: [],
          summary: "Checked against the design: page maps to the offset and slicing past the end returns []. No issues.",
        }),
      ),
    ]);
  }

  const user = lab.lastUserText(params);
  const spec = user.match(/<spec>\n([\s\S]*?)\n<\/spec>/);
  const code = user.match(/<code>\n([\s\S]*?)\n<\/code>/);
  const findings: { issue: string; severity: string; confidence: number }[] = [];
  if (spec && code && spec[1].includes("1-based") && /start = page \* page_size/.test(code[1])) {
    findings.push({
      issue:
        "Off-by-one: the spec says pages are 1-based, but start = page * page_size skips the first page " +
        "(page=1, page_size=3 returns items[3:6]). Use start = (page - 1) * page_size.",
      severity: "high",
      confidence: 0.92,
    });
  }
  return lab.message([lab.text(JSON.stringify({ findings }))]);
}
