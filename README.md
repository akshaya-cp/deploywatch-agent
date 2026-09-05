# DeployWatch

An autonomous deployment-monitoring agent on Cloudflare Workers. It detects
service anomalies on a schedule, asks an LLM what to do about them, and then
**ignores the LLM if policy says otherwise.**

**Live:** https://deploywatch-agent.akshaya-cp.workers.dev

---

## Thesis

An LLM cannot be trusted to act on production infrastructure. The response to
that is not to make the model more trustworthy — it is to make it *powerless*.

The model proposes. A deterministic policy layer disposes.

Every design decision in this repo follows from that sentence. Where the model
is wrong, the system is still right; where the model is unavailable, the system
still fails safe.

---

## What it does

```
   TIMER ──> runHealthCheck ──> diagnose (LLM) ──> applyPolicy ──> setState ──┐
                                                                              │
                                                                    state (Durable Object)
                                                                              │
   HUMAN ──> onChatMessage ──> getIncidentHistory ─────────────────────────────┘
```

Two independent entry points, one shared durable memory. The agent works when
nobody is watching; the chat interface is a window onto what it did.

1. **Detect** — a scheduled health check runs on an interval and flags anomalies.
2. **Diagnose** — the anomaly is sent to Llama 3.3 on Workers AI, which returns
   a recommended action (`retry` / `rollback` / `escalate`) and its reasoning.
3. **Decide** — `applyPolicy()` re-derives the correct action from the raw
   metric, independent of what the model said. Disagreements are recorded, not
   silently resolved.
4. **Remember** — the incident, the model's recommendation, the final action,
   and whether policy overrode the model are persisted to Durable Object state.
5. **Explain** — a chat interface queries that history conversationally.

---

## Why the policy layer exists

Not as decoration. It was added in response to an observed failure.

During development the agent classified a **49% error rate as `rollback`**, when
the prompt explicitly specified `escalate` for anything above 40%. The model's
reasoning was fluent and plausible. It was also wrong, and a fluent wrong answer
that triggers an automated rollback is worse than no answer at all.

So the threshold logic was moved out of the model:

```ts
function applyPolicy(value: number, recommended: Action) {
  if (value > POLICY.escalateAboveErrorRate) {
    return { finalAction: "escalate", policyOverride: recommended !== "escalate" };
  }
  return { finalAction: recommended, policyOverride: false };
}
```

The policy never reads the model's output to decide. It reads the raw number.
The model's answer is only used to *detect disagreement*, which is recorded as
`policyOverride` so the audit trail explains why an action differed from the
recommendation.

**Known limitation:** the current policy only guards the high end. A model error
in the other direction — recommending `retry` for a 21% error rate — passes
through unchallenged. Closing that gap is v2 work.

---

## Evaluation

`runEvals()` runs fixed scenarios through the full `diagnose() → applyPolicy()`
path and reports three things: how often the model was right, how often policy
had to override it, and whether the model agrees with *itself* on repeated
identical inputs.

Scenarios cluster at decision boundaries (19/21, 39/41), with repeats, because
that is where a fuzzy classifier fails and where a deterministic guardrail earns
its place.

<!-- V2: replace with actual output of runEvals() -->
| Metric | Result |
|---|---|
| Total runs | _pending_ |
| Model accuracy | _pending_ |
| Policy override rate | _pending_ |
| Inconsistent on repeated input | _pending_ |

**On what a good result looks like:** 100% model accuracy would be a bad
outcome, not a good one. It would mean the task was simple enough that an
`if/else` would have sufficed and both the LLM and the policy layer are dead
weight. The value of this system is proportional to how often the model is
wrong.

**Measurement integrity:** `diagnose()` distinguishes an inference failure
(quota, network, model unavailable) from a parse failure. Both fail safe to
`escalate` in production. But evals abort rather than scoring an infrastructure
error as a model decision — fail safe in production, fail loud in evaluation.

---

## Architecture notes

**Why Durable Objects.** A normal Worker forgets everything between requests,
which is fine for an API and useless for an agent tracking an ongoing incident.
A Durable Object is a single instance with a stable identity, private storage,
and strong consistency — no distributed locking, no race conditions, and state
that survives restarts and deploys. An agent is a stateful object with a
scheduler; Durable Objects are the primitive that makes that possible.

**Why `scheduleEvery` and not `schedule`.** The first implementation
self-rescheduled inside the handler and also scheduled from `onStart()`. Every
Durable Object restart created another timer, so timers multiplied — the runtime
eventually reported processing ten stale schedules in a single alarm cycle.
`scheduleEvery()` is idempotent recurrence. This is a duplicate-scheduled-work
bug, and it is the reason v2 moves to deterministic keys throughout.

**Why the diagnosis path doesn't use tool calling.** Tool-argument validation
proved unreliable with the fp8-quantized model. Rather than fight it, `diagnose()`
requests JSON and parses it explicitly, with a fail-safe default. For anything
that could trigger a deployment action, explicit validation beats trusting raw
tool arguments.

**Model selection.** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` — Cloudflare-hosted,
function-calling capable, available on the free tier.

---

## Built on

This is built on [`cloudflare/agents-starter`](https://github.com/cloudflare/agents-starter),
which provides the agent runtime, Durable Object wiring, chat UI, WebSocket
transport, MCP client support, and scheduling primitives.

**What I added:** the state schema, the monitoring loop, LLM diagnosis with
fail-safe parsing, the policy layer, the eval harness, and the incident-history
tool. The starter's demo tools (`getWeather`, `calculate`, `getUserTimezone`)
were removed.

---

## Known issues

**Duplicated tokens in streamed chat output.** Each token in the assistant's
streamed reply renders twice.

Investigated by: upgrading `agents` 0.17→0.22 and `@cloudflare/ai-chat` 0.9→0.11
(both ship fixes for related Workers AI stream-reconciliation bugs — duplicate
assistant messages when a provider omits `start.messageId`, and a double-ACKed
stream resume replaying the chunk buffer); disabling `resume` and `chatRecovery`;
passing `onFinish` through per the SDK docs; swapping models. None resolved it.
`workers-ai-provider@4` requires `ai@7`, a major upgrade across the whole stack
that was not justified for a display-only bug.

Currently worked around at render time in `app.tsx`. **This is a workaround, not
a fix** — it collapses the doubling but will also collapse legitimate repetition.
It is applied only to assistant text; user input, stored incident data, and the
non-streamed diagnosis path are unaffected.

**Simulated monitoring.** Anomalies are generated, not observed. There is no
real telemetry source. The agent architecture is the subject here; wiring a real
metrics source is a substitution, not a redesign.

---

## Running it

```bash
npm install
npx wrangler login
npm run dev      # http://localhost:5173
npm run deploy
```

Workers AI runs in remote mode — a Cloudflare login is required even for local
development. No third-party API keys are needed.

---

## AI-assisted development

Prompt history: [`docs/prompt-history.md`](docs/prompt-history.md)

<!-- V2: expand once the full session is curated -->

---

## Roadmap

<!-- V2 SECTIONS SLOT IN HERE -->

The current system demonstrates the propose/dispose split at its simplest: the
model recommends, policy decides, nothing executes. The next layer is making
execution itself safe.

- **Deterministic incident keys** — derive an incident key from
  `service + metric + window` rather than a random UUID, so the same incident
  detected twice resolves to the same identity. This is the recovery surface
  everything else depends on.
- **Execution-time authorization** — expose `rollbackDeployment` as a real tool
  whose handler re-validates policy on every call. A tool schema is not a
  security boundary; the handler is.
- **Idempotent remediation** — key side effects on `(incidentKey, callId)` and
  return the cached result on replay, so a retried execution cannot double-fire
  a rollback.
- **Crash recovery** — demonstrate a Durable Object restart mid-remediation
  resuming without duplicating work.
- **Full audit trail** — persist every proposal, authorization decision, and
  execution, not just outcomes.
- **Bidirectional policy** — guard the low end as well as the high end.