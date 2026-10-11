# D5.2: Design effective escalation and ambiguity resolution patterns

**Domain 5: Context Management & Reliability (15%)** · Task Statement 5.2
**Exam scenarios:** Customer Support Resolution Agent

## What the exam expects

| Knowledge | Skill |
|---|---|
| The right escalation triggers: the customer asks for a human, a policy exception or gap (not just "complex"), or the agent cannot make meaningful progress | Add explicit escalation criteria with few-shot examples to the system prompt showing when to escalate and when to resolve |
| Escalate immediately when a customer explicitly demands a human; offer to resolve when the issue is straightforward | Honour explicit requests for a human immediately, without investigating first |
| Sentiment-based escalation and self-reported confidence are unreliable proxies for case complexity | Acknowledge frustration and offer a resolution when the issue is within the agent's capability; escalate only if the customer repeats the preference |
| Multiple customer matches need clarification (more identifiers), not heuristic selection | Escalate when policy is ambiguous or silent (e.g. competitor price matching when policy covers only own-site adjustments); ask for more identifiers on multiple matches |

## The pattern

```
system prompt =
    POLICY             what is covered (damage + photo, own-site price drop within 14 days, 30-day refunds)
                       and what is NOT (competitor price match, bulk discounts, exceptions)
    ESCALATION CRITERIA
        explicit_request  -> escalate_to_human FIRST, no lookup
        policy_gap / policy_exception -> escalate, do not improvise policy
        no_progress       -> escalate when tools cannot move the case forward
        NOT a trigger: complexity, emotion, order value
    EXAMPLES           few-shot pairs: customer message -> the right action

per new customer turn (state rebuilt from the full history):
    explicit request, or a hint repeated twice  -> escalate
    hint once + solvable                        -> acknowledge, offer, keep the door open
    several matches from lookup_customer        -> ask for email / postal code
```

## Files

| File | What it shows |
|---|---|
| `fixtures/cases.json` | 13 labelled cases (escalate / resolve / reply) with the logged sentiment score and self-reported confidence |
| `fixtures/backend.json` | Orders and customers for the simulated tools (three accounts named John Smith) |
| `python/support_agent.py`, `typescript/supportAgent.ts` | Both system prompts, six tools, the agent loop, conversation-state tracking, and the scripted model with a "vague prompt" and an "explicit criteria" profile |
| `python/escalation_agent.py`, `typescript/escalationAgent.ts` | The case table under both prompts, with a scorecard of sample Q3's two symptoms |
| `python/frustration_state.py`, `typescript/frustrationState.ts` | Explicit demand vs frustrated hint (repeated or accepted) across turns |
| `python/multiple_matches.py`, `typescript/multipleMatches.ts` | Ask for an identifier vs pick the "most recent" John Smith |
| `python/unreliable_proxies.py`, `typescript/unreliableProxies.ts` | Agreement of sentiment, self-confidence and explicit criteria with the labels |

## Run it

```bash
python "D5.2 - Escalation and Ambiguity Resolution Patterns/python/escalation_agent.py"
python "D5.2 - Escalation and Ambiguity Resolution Patterns/python/frustration_state.py"
python "D5.2 - Escalation and Ambiguity Resolution Patterns/python/multiple_matches.py"
python "D5.2 - Escalation and Ambiguity Resolution Patterns/python/unreliable_proxies.py"
npx tsx "D5.2 - Escalation and Ambiguity Resolution Patterns/typescript/escalationAgent.ts"
python "D5.2 - Escalation and Ambiguity Resolution Patterns/python/escalation_agent.py" --live   # real model, same cases
```

Expected offline output (abridged):

```
  case  expected  vague prompt              explicit criteria
  C01   escalate    escalate 1st=lookup       escalate 1st=escalate   I want to speak to a human, please...
  C02   resolve   x escalate 1st=lookup       resolve  1st=lookup     My blender (ORD-7002) arrived with a cra...
  C03   escalate  x resolve  1st=lookup       escalate 1st=lookup     BestMart has my headphones (ORD-7003)...
--- Scorecard ---
  correct decisions                                vague:  6 (46.2%)   criteria: 13 (100.0%)
  straightforward cases escalated                  vague:  3           criteria:  0
  policy gaps/exceptions handled without a human   vague:  4           criteria:  0

  rule                       agreement  missed  unneeded
  sentiment < -0.5               38.5%       6         2
  self_confidence < 6            30.8%       6         3
  explicit criteria             100.0%       0         0
```

## Escalation decision table

| Customer situation | Right action | Why |
|---|---|---|
| "I want to speak to a human" | `escalate_to_human` first, no lookup | Explicit request: honour it immediately |
| Damaged item + photo, customer furious | Acknowledge, `issue_replacement` | Covered by policy; emotion is not a trigger |
| Frustrated + "maybe I should talk to a person" | Acknowledge, offer the fix, say a person is available | A hint, not a demand |
| ...and the customer says it again | `escalate_to_human` | The preference was repeated (state: 2 mentions) |
| Competitor price match, bulk discount | `escalate_to_human` (policy_gap) | Policy is silent; do not improvise |
| Refund outside the window "as an exception" | `escalate_to_human` (policy_exception) | Exceptions need a human |
| Refund issued but never arrived; no trace tool | `escalate_to_human` (no_progress) | The agent cannot move it forward |
| Damage, no photo | Ask for a photo | Missing input, not an escalation |
| Name matches three accounts | Ask for email or postal code | Never select by heuristic |

## Exam traps

- **Sample Q3: low first-contact resolution, wrong cases escalated.** The answer is explicit criteria plus few-shot examples in the system prompt (A). It fixes the unclear decision boundary directly and is the proportionate first step. In the demo, the same model goes from 6/13 to 13/13 correct decisions with no new infrastructure.
- **Self-reported confidence (Q3 option B).** It is poorly calibrated. Here the agent rated itself 8-9/10 on five cases that need a human, exactly where it was about to improvise policy. Routing on confidence missed 6 of 7 escalations.
- **Sentiment analysis (Q3 option D).** It solves a different problem. Sentiment escalated two furious customers with covered problems and missed polite customers asking for things the policy does not cover. Agreement: 38.5%.
- **A separate classifier (Q3 option C).** Over-engineered as a first step: it needs labelled data and ML infrastructure before prompt changes have been tried.
- **"Investigate first, then escalate."** For an explicit request this is wrong even if the final outcome is an escalation. The vague prompt reached "escalate" on C01 and C08, but only after a lookup.
- **Escalating because a case is complex or emotional.** Complexity alone is not a trigger. Policy gaps and exceptions are, even when the customer is calm and polite (C12).
- **Multiple matches: "pick the most recently active account."** That disclosed another customer's order in the demo. Ask for an additional identifier.
- Escalation is a handoff: pass a structured summary (`reason_category`, `summary`, `order_id`) so the human does not have to start over. See [D1.4](<../D1.4 - Multi-Step Workflows with Enforcement and Handoff/README.md>) for programmatic enforcement of the same rules.

## Try this next

1. Add a case "Can you waive the restocking fee?" and decide which criterion it falls under. Add a few-shot example for it and re-run.
2. Remove the EXAMPLES section from `CRITERIA_PROMPT` and run `escalation_agent.py --live`. Compare the live scorecard with and without few-shot examples.
3. Add a third frustration scenario where the hint is followed by an explicit demand ("No. Transfer me now.") and check it escalates on that turn.
