/**
 * D1.4 - Structured handoff when escalating mid-process to a human agent.
 *
 * A $899 refund is above the agent's $500 limit, so the gate blocks process_refund with a structured
 * error whose required_next_step is escalation. The model then calls escalate_to_human with a
 * HandoffSummary (customer_id, issue_summary, root_cause, refund_amount, actions_taken,
 * recommended_action, priority). The tool layer validates it, because the human picking up the
 * ticket has NO access to the transcript: the summary is all they get.
 *
 * The anti-pattern ("customer upset about TV, see chat") is rejected with the list of what's missing.
 *
 * Run:  npx tsx handoff.ts          (offline)
 *       npx tsx handoff.ts --live   (real API)
 */
import * as lab from "../../shared/typescript/labkit.ts";
import {
  AGENT_REFUND_LIMIT,
  HANDOFF_FIELDS,
  ORDERS,
  ToolLayer,
  makeSupportModel,
  renderTicket,
  runAgent,
  validateHandoff,
} from "./supportTools.ts";

const REQUEST =
  "Hi, I'm Sam Rivera (sam@example.com). The TV from order ORD-2002 arrived with a cracked screen. " +
  "I want a full refund of $899.00.";

lab.banner("D1.4  Structured handoff to a human agent");

lab.section("Escalation mid-process: refund above the agent limit");
console.log(`user: ${REQUEST}`);
const tools = new ToolLayer(true);
const { answer } = await runAgent(lab.getClient(makeSupportModel()), REQUEST, tools);
console.log(`assistant: ${answer}`);
const sequence = tools.calls.map((c) => `${c.tool}:${c.outcome}`);
console.log(`tool calls: ${JSON.stringify(sequence)}`);

lab.check(tools.refunds.every((r) => r.amount <= AGENT_REFUND_LIMIT), `no refund above $${AGENT_REFUND_LIMIT} ran without a human`);
lab.check(tools.escalations.length >= 1, "the case was escalated to a human");
const ticket = tools.escalations[tools.escalations.length - 1]; // the accepted one (an invalid handoff never creates a ticket)
const summary = ticket.summary;

lab.section("What the human agent sees (no transcript, only this ticket)");
console.log(renderTicket(ticket.ticket_id, summary));
lab.check(validateHandoff(summary).length === 0, `the handoff has every required field: ${HANDOFF_FIELDS.join(", ")}`);
lab.check(tools.verified !== null && summary.customer_id === tools.verified.customer_id,
  "customer_id is the VERIFIED id from get_customer, not a name");
if (!lab.isLive()) {
  lab.check(JSON.stringify(sequence) === JSON.stringify(["get_customer:ok", "lookup_order:ok", "process_refund:blocked", "escalate_to_human:ok"]),
    "verify -> look up -> refund blocked by the limit -> escalate");
  lab.check(summary.refund_amount === ORDERS["ORD-2002"].total, "refund_amount matches the looked-up order ($899.00)");
  lab.check(summary.actions_taken.some((a) => a.includes("blocked")), "actions_taken records the blocked refund, so the human won't retry it blindly");
}

lab.section("Anti-pattern: a free-text handoff");
const bad = { customer_id: "Sam Rivera", issue_summary: "Customer is upset about a TV, see chat." };
console.log(`escalate_to_human(${JSON.stringify(bad)})`);
const [content, isError] = new ToolLayer(true).execute("escalate_to_human", bad);
console.log(`  -> is_error=${isError} ${content}`);
const problems = (JSON.parse(content) as { problems: string[] }).problems;
const missing = problems.filter((p) => p.endsWith("missing")).map((p) => p.split(":")[0]);
lab.check(isError && JSON.stringify(missing) === JSON.stringify(["root_cause", "refund_amount", "actions_taken", "recommended_action", "priority"]),
  "rejected: no root cause, amount, actions, recommendation or priority for a human who can't read the chat");
lab.check(problems.some((p) => p.startsWith("customer_id: must be a verified id")), "and a name is not a customer_id");
