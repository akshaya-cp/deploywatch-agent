# Prompt history

This project was built with AI assistance throughout (Claude, in VS Code),
starting from the `cloudflare/agents-starter` template.

What follows is not a transcript. It is the set of corrections that mattered —
where the AI's first answer was wrong, where I overrode it, and where a bug went
unresolved. Where something was not root-caused, it is recorded as
not root-caused.

The corrections are more informative than the successes.

---

## 1. Duplicate timers from self-rescheduling

**Asked for:** a health check that runs every 30 seconds and survives Durable
Object restarts.

**What came back:** a handler that scheduled its own successor, plus a
`this.schedule()` call in `onStart()`.

```ts
onStart() {
  this.schedule(30, "runHealthCheck");
}

async runHealthCheck() {
  // ...work...
  this.schedule(30, "runHealthCheck");   // schedules the next run
}
```

**What went wrong:** every Durable Object restart re-ran `onStart()` and created
another timer, while each execution also created its own successor. Timers
multiplied. Within minutes the runtime was reporting *"Processing 10 stale
`runHealthCheck` schedules in a single alarm cycle."* Check counts climbed to 55
in five minutes instead of the expected ten.

**Fix:**

```ts
onStart() {
  this.scheduleEvery(30, "runHealthCheck");   // idempotent recurrence
}
```

and the self-reschedule removed from the handler.

**Lesson:** in a system where restarts are routine — deploys, crashes,
hibernation — scheduling has to be idempotent. Recurrence built by chaining
one-shot timers is a duplicate-work bug waiting for its first restart. This is
the reason the v2 roadmap moves to deterministic keys throughout.

---

## 2. Building on a model that wasn't available

**Asked for:** get the starter running against Workers AI.

**What happened:** the starter ships with `@cf/moonshotai/kimi-k2.7-code` as its
default model, which is not available on the Workers free plan. Every request
failed with `5035: Model ... is not available on the Workers Free plan`.

**What I corrected:** before swapping in a replacement, I checked two things
rather than picking the first free model: that it supports function calling (the
starter passes six tools with `tool_choice: "auto"`, so a model without function
calling would break the whole template), and that it wasn't slated for
deprecation mid-project. Settled on
`@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

**Lesson:** verify a model's availability *and* its capability surface before
building on it. The failure mode was loud here; a model that silently lacked
function calling would have been much harder to diagnose.

---

## 3. A parser that assumed one return type

**Asked for:** parse the LLM's JSON response into `action` and `reasoning`.

**What came back:** an unconditional `JSON.parse(raw.trim())`.

**What went wrong:** the Workers AI binding sometimes returns `response` as an
already-parsed object rather than a JSON string. `.trim()` on an object threw,
the `catch` fired, and the incident was recorded as:

```
action: "escalate", reasoning: "Could not parse LLM response"
```

The tell was in the log — `{ action: 'escalate', reasoning: '...' }` with single
quotes and unquoted keys. That is Node printing an object, not a JSON string.
The model had answered correctly the whole time.

**Fix:**

```ts
const parsed = typeof raw === "string" ? JSON.parse(raw.trim()) : raw;
```

**Lesson:** the fail-safe worked — a broken parser still produced a conservative
outcome instead of crashing or triggering something destructive. But it also
*masked* the bug for several runs by making a parsing failure look like a model
failure. A fail-safe that swallows the distinction between "the model was wrong"
and "my code was wrong" will hide real defects. This is why `diagnose()` now
returns a `failed` flag: fail safe in production, fail loud in evaluation.

---

## 4. Correcting the policy design

**Asked for:** a policy gate that enforces escalation above a 40% error rate.

**What came back:**

```ts
if (diagnosis.action === "escalate") {
  finalAction = "escalate";
}
```

**Why that's wrong:** it checks *what the model said*. The model is still making
the decision; this only verifies it said the right word. It is a spell-checker,
not a guardrail. If the model classifies a 49% error rate as `rollback` — which
it did, in testing — this code passes it straight through.

**Fix:** the policy ignores the model's output entirely when deciding, and
re-derives the action from the raw metric:

```ts
function applyPolicy(value: number, recommended: Action) {
  if (value > POLICY.escalateAboveErrorRate) {
    return {
      finalAction: "escalate",
      policyOverride: recommended !== "escalate"
    };
  }
  return { finalAction: recommended, policyOverride: false };
}
```

The model's answer is used only to *detect disagreement*, recorded as
`policyOverride` for the audit trail.

**Lesson:** this is the design error rather than a syntax error, and it is the
one that changed the system's shape. It moved the architecture from
"AI-recommended" to "AI-advised, policy-enforced." The model proposes; the
policy disposes.

---

## 5. Designing the evaluation, not proving a point

**Asked for:** an evaluation harness that runs fixed scenarios and reports
results.

**What came back:** a script reporting model accuracy, including a pre-written
`readmeSentence` field asserting that the guardrail was "essential."

**What I corrected:**

- **Removed the pre-written conclusion.** Asserting the result before running
  the experiment is backwards, and if overrides came out at 0% the string would
  simply be false. The harness reports numbers; the conclusion gets written
  after reading them.
- **Added non-determinism tracking.** Running the same value three times is
  pointless if nothing checks whether the three runs agreed. If a 19% error rate
  returns both `retry` and `rollback` across identical inputs, that single fact
  argues for the policy layer more strongly than any accuracy percentage.
- **Typed the expected values** as `Action` rather than `string`, so a typo in a
  test case fails at compile time instead of silently scoring as a miss.
- **Separated infrastructure failure from model failure**, so a quota error
  can't be scored as a decision the model made.

**On what a good result looks like:** 100% model accuracy would be a *bad*
outcome. It would mean the task was simple enough for an `if/else` and that both
the LLM and the policy layer are dead weight. The system's value is proportional
to how often the model is wrong.

**Lesson:** an eval measures the system; it does not advocate for it.

---

## 6. A bug I did not solve

**Symptom:** every token in the streamed chat response renders twice —
`TheThe services services`.

**What I tried, in order:**

1. Swapped the model — no change, so not model-specific.
2. Removed `sessionAffinity` from the model call — no change.
3. Passed `onFinish` through to `streamText`, which the SDK docs require for
   correct message persistence and was missing — no change.
4. Upgraded `agents` 0.17 → 0.22 and `@cloudflare/ai-chat` 0.9 → 0.11. The
   changelogs contain two directly relevant fixes: duplicate assistant messages
   when a provider omits `start.messageId` (Workers AI is named explicitly), and
   a stream-resume offer being ACKed twice, replaying the chunk buffer into the
   same accumulator. Neither resolved it.
5. Disabled `resume` on the client and `chatRecovery` on the agent, targeting
   the replay path directly — no change.

`workers-ai-provider@4` would have been the next step, but it requires `ai@7` —
a major-version upgrade across the entire stack, for a display-only bug, close
to a deadline. I stopped there.

**Current state:** worked around at render time in `app.tsx` by collapsing the
doubling. This is a workaround, not a fix. It will also collapse legitimate
repetition, so it is applied only to assistant text — never to user input,
stored incident data, or the non-streamed diagnosis path.

**Not root-caused.** I know which layers it is *not* in. I do not know which
layer it is in.

**Lesson:** the useful part here was recognising when to stop. Reading the
upstream changelogs was worth more than another round of guessing, and the
correct call at the end was to bound the blast radius and document the gap
rather than force a stack-wide upgrade the night before shipping.