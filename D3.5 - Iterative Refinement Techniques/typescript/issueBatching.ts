/**
 * D3.5 - One detailed message for interacting issues, sequential messages for independent ones.
 *
 * Issues INTERACT when their fixes touch the same function or the same data; fixing them one at a time
 * makes each later fix redo or break the earlier one. Send those together with every expectation that
 * must hold at once. Independent issues go one per message so each fix is small and verified alone.
 *
 * Run:  npx tsx issueBatching.ts
 */
import * as lab from "../../shared/typescript/labkit.ts";

interface Issue {
  id: string;
  summary: string;
  touches: string[]; // functions / fields / files the fix has to change
  expected: string; // a concrete input -> output that must hold after the fix
}

const ISSUES: Issue[] = [
  { id: "I1", summary: "normalize_price rounds half-down; amounts must round half-up to whole cents", touches: ["fn:normalize_price", "field:price_cents"], expected: "normalize_price(10.005, 'USD') -> 1001 cents, not 1000" },
  { id: "I2", summary: "normalize_price rounds BEFORE converting currency; convert first, then round once", touches: ["fn:normalize_price", "field:price_cents"], expected: "normalize_price(9.99, 'EUR') at rate 1.0832 -> 1082 cents" },
  { id: "I3", summary: "apply_discount subtracts the coupon before tax; the spec applies coupons after tax", touches: ["fn:apply_discount", "field:price_cents"], expected: "100.00 + 20% tax - 5.00 coupon -> 11500 cents, not 11400" },
  { id: "I4", summary: "log_order message has a typo ('recieved')", touches: ["fn:log_order"], expected: "log line reads 'Order received: ord_1'" },
  { id: "I5", summary: "README example still passes the removed --legacy-pricing flag", touches: ["file:README.md"], expected: "the README example runs on the current CLI" },
];

/** Union issues that share any function, field or file; each group is fixed in one message. */
function groupInteracting(issues: Issue[]): Issue[][] {
  const parent = new Map(issues.map((i) => [i.id, i.id] as [string, string]));
  const find = (x: string): string => {
    let node = x;
    while (parent.get(node) !== node) node = parent.get(node) ?? node;
    return node;
  };
  issues.forEach((a, i) => {
    for (const b of issues.slice(i + 1)) if (a.touches.some((t) => b.touches.includes(t))) parent.set(find(b.id), find(a.id));
  });
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) groups.set(find(issue.id), [...(groups.get(find(issue.id)) ?? []), issue]);
  return [...groups.values()];
}

/** [kind, issue ids, message text]: interacting groups first, then independent issues one by one. */
function planMessages(issues: Issue[]): Array<[string, string[], string]> {
  const groups = groupInteracting(issues);
  const messages: Array<[string, string[], string]> = [];
  for (const group of groups.filter((g) => g.length > 1)) {
    const shared = group[0].touches.filter((t) => group.every((i) => i.touches.includes(t)));
    const lines = [
      `These ${group.length} issues interact - they all change ${shared.map((s) => s.split(":")[1]).join(", ")}. ` +
        "Fix them together in one change so each fix accounts for the others; fixing them one at a time " +
        "would make every later fix redo or break the earlier ones.",
      "",
      ...group.map((i, n) => `${n + 1}. [${i.id}] ${i.summary}\n   expected: ${i.expected}`),
      "",
      "After your change, ALL of the expectations above must hold at the same time. Add a test for each.",
    ];
    messages.push(["combined", group.map((i) => i.id), lines.join("\n")]);
  }
  for (const [issue] of groups.filter((g) => g.length === 1)) {
    messages.push(["single", [issue.id], `Fix one independent issue (nothing else depends on it): [${issue.id}] ${issue.summary}\nexpected: ${issue.expected}`]);
  }
  return messages;
}

lab.banner("D3.5  Interacting issues in one message, independent issues one at a time");
lab.section("Grouping by shared functions / fields / files");
for (const group of groupInteracting(ISSUES)) {
  const touched = [...new Set(group.flatMap((i) => i.touches))].sort();
  console.log(`  ${group.map((i) => i.id).join("+").padEnd(10)} ${(group.length > 1 ? "interacting" : "independent").padEnd(12)} touches ${JSON.stringify(touched)}`);
}

lab.section("Messages to send, in order");
const messages = planMessages(ISSUES);
messages.forEach(([kind, ids, text], n) => {
  console.log(`\n  message ${n + 1} (${kind}, ${ids.join(", ")}):`);
  console.log(text.split("\n").map((line) => `    | ${line}`).join("\n"));
});

lab.section("Checks");
const kinds = messages.map(([kind, ids]) => `${kind}:${ids.join(",")}`);
lab.check(kinds[0] === "combined:I1,I2,I3", "I1, I2 and I3 go in ONE detailed message");
lab.check(!ISSUES[2].touches.includes("fn:normalize_price"), "I3 is in a different function but joins the group through the shared price_cents field");
lab.check(JSON.stringify(kinds.slice(1)) === '["single:I4","single:I5"]', "the log typo and the README fix go one at a time");
lab.check(ISSUES.slice(0, 3).every((i) => messages[0][2].includes(i.expected)), "the combined message states every expectation that must hold together");
