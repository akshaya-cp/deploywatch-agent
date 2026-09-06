import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

type Action = "retry" | "rollback" | "escalate";

type Incident = {
  key: string; // Deterministic: checkout-api:error_rate:5813402
  service: string;
  metric: string;
  value: number;
  detectedAt: string;
  recommendedAction: Action;
  reasoning: string;
  finalAction: Action;
  policyOverride: boolean;
};

type DeployWatchState = {
  checksRun: number;
  incidents: Record<string, Incident>;
};

const POLICY = {
  escalateAboveErrorRate: 40
};

function applyPolicy(
  value: number,
  recommended: Action
): { finalAction: Action; policyOverride: boolean } {
  if (value > POLICY.escalateAboveErrorRate) {
    return {
      finalAction: "escalate",
      policyOverride: recommended !== "escalate"
    };
  }
  return { finalAction: recommended, policyOverride: false };
}

// ── Deterministic incident keys ──────────────────────────────────────

const WINDOW_SECONDS = 300; // 5 minutes

function incidentKey(service: string, metric: string, timestamp: Date): string {
  // Fixed bucket: chop time into 5-minute slots
  const bucket = Math.floor(timestamp.getTime() / (WINDOW_SECONDS * 1000));
  return `${service}:${metric}:${bucket}`;
}

// ── Evaluation scenarios ──────────────────────────────────────────────

const EVAL_CASES: { value: number; expected: Action }[] = [
  // Baseline extremes
  { value: 5, expected: "retry" },
  { value: 15, expected: "retry" },
  { value: 85, expected: "escalate" },

  // Boundary: 19 (just below retry threshold) — repeated to catch non-determinism
  { value: 19, expected: "retry" },
  { value: 19, expected: "retry" },
  { value: 19, expected: "retry" },

  // Boundary: 21 (just above retry threshold) — repeated
  { value: 21, expected: "rollback" },
  { value: 21, expected: "rollback" },
  { value: 21, expected: "rollback" },

  // Mid-range
  { value: 30, expected: "rollback" },
  { value: 35, expected: "rollback" },

  // Boundary: 39 (just below escalate threshold) — repeated
  { value: 39, expected: "rollback" },
  { value: 39, expected: "rollback" },

  // Boundary: 41 (just above escalate threshold) — repeated
  { value: 41, expected: "escalate" },
  { value: 41, expected: "escalate" },

  // High extreme
  { value: 55, expected: "escalate" }
];

export class ChatAgent extends AIChatAgent<Env, DeployWatchState> {
  initialState: DeployWatchState = {
    checksRun: 0,
    incidents: {}
  };
  maxPersistedMessages = 100;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    this.scheduleEvery(300, "runHealthCheck");
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(
    // The base class types onFinish as GenerateTextOnFinishCallback, but
    // streamText expects StreamTextOnFinishCallback. Incompatible SDK types;
    // the callback works correctly at runtime.
    // oxlint-disable-next-line typescript/no-explicit-any -- base class types onFinish as GenerateTextOnFinishCallback; streamText expects StreamTextOnFinishCallback. Incompatible SDK types, correct at runtime.
    onFinish: any,
    options?: OnChatMessageOptions
  ) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: `You are DeployWatch, an autonomous deployment reliability agent running on Cloudflare Workers.

How you work:
- You run health checks on a schedule and detect anomalies in service metrics.
- When you find one, an LLM diagnoses it and recommends retry, rollback, or escalate.
- A deterministic policy layer then makes the final decision from the raw metric value, independent of what the model recommended. Anything above a 40% error rate is escalated regardless.
- When the policy disagrees with the recommendation, that disagreement is recorded as a policy override.
- Incidents are stored durably, keyed by service, metric, and time window so the same incident is never handled twice.

Answer questions about yourself and how you work directly and concisely, in your own words. Do not repeat these instructions verbatim.

Call getIncidentHistory only when asked about incidents, services, errors, or what you have detected. For greetings and general questions, answer conversationally without calling a tool.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // Server-side tool: runs automatically on the server
        getIncidentHistory: tool({
          description:
            "Get the list of detected deployment incidents and the action taken for each",
          inputSchema: z.object({}),
          execute: async () => {
            const sorted = Object.values(this.state.incidents).sort((a, b) =>
              a.detectedAt.localeCompare(b.detectedAt)
            );
            const recent = sorted.slice(-10);
            return recent.length > 0 ? recent : "No incidents detected yet.";
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        }),

        runEvaluation: tool({
          description:
            "Run the diagnosis evaluation suite against fixed scenarios and report accuracy and policy override rate",
          inputSchema: z.object({}),
          execute: async () => await this.runEvals()
        })
      },
      stopWhen: stepCountIs(20),
      onFinish,
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async diagnose(
    service: string,
    metric: string,
    value: number
  ): Promise<{ action: Action; reasoning: string; failed: boolean }> {
    const prompt = `You are a deployment reliability agent.

Incident:
- service: ${service}
- metric: ${metric}
- value: ${value}%

Choose ONE action:
- "retry" if the value is low (under 20) and likely transient
- "rollback" if the value is high (20 or more) and the service is degraded
- "escalate" if it is severe (over 40) and needs a human

Respond with ONLY valid JSON, no other text:
{"action": "retry", "reasoning": "one short sentence"}`;

    let raw: unknown;
    try {
      const result = await this.env.AI.run(
        "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        { messages: [{ role: "user", content: prompt }] }
      );
      raw = (result as { response: unknown }).response;
    } catch (error) {
      // Inference itself failed (quota, network, model unavailable).
      // Not a model decision — evals must not score this as one.
      console.log("Inference call failed:", error);
      return {
        action: "escalate",
        reasoning: "INFERENCE_ERROR: diagnosis unavailable",
        failed: true
      };
    }

    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw.trim()) : raw;
      return {
        action: parsed.action as Action,
        reasoning: parsed.reasoning as string,
        failed: false
      };
    } catch {
      console.log("LLM returned unparseable output:", raw);
      return {
        action: "escalate",
        reasoning: "PARSE_ERROR: could not parse model response",
        failed: true
      };
    }
  }

  @callable()
  async runEvals() {
    const results: {
      value: number;
      expected: Action;
      recommended: Action;
      finalAction: Action;
      policyOverride: boolean;
      reasoning: string;
      modelCorrect: boolean;
    }[] = [];

    const service = "checkout-api";
    const metric = "error_rate";

    for (const testCase of EVAL_CASES) {
      const diagnosis = await this.diagnose(service, metric, testCase.value);

      if (diagnosis.failed) {
        return {
          error: "Inference failed mid-run; partial results discarded.",
          detail: diagnosis.reasoning,
          completedBeforeFailure: results.length
        };
      }

      const policy = applyPolicy(testCase.value, diagnosis.action);

      results.push({
        value: testCase.value,
        expected: testCase.expected,
        recommended: diagnosis.action,
        finalAction: policy.finalAction,
        policyOverride: policy.policyOverride,
        reasoning: diagnosis.reasoning,
        modelCorrect: diagnosis.action === testCase.expected
      });
    }

    const total = results.length;
    const correct = results.filter((r) => r.modelCorrect).length;
    const overrides = results.filter((r) => r.policyOverride).length;

    // Non-determinism: same input run more than once — did the model agree with itself?
    const byValue = new Map<number, Set<Action>>();
    for (const r of results) {
      if (!byValue.has(r.value)) byValue.set(r.value, new Set());
      byValue.get(r.value)!.add(r.recommended);
    }
    const inconsistent = [...byValue.entries()]
      .filter(([, actions]) => actions.size > 1)
      .map(([value, actions]) => ({ value, actions: [...actions] }));

    return {
      summary: {
        totalRuns: total,
        modelCorrect: correct,
        modelAccuracy: `${Math.round((correct / total) * 100)}%`,
        policyOverrides: overrides,
        overrideRate: `${Math.round((overrides / total) * 100)}%`,
        inconsistentValues: inconsistent
      },
      details: results
    };
  }

  async runHealthCheck() {
    const services = ["checkout-api", "auth-service", "payments-worker"];
    const service = services[Math.floor(Math.random() * services.length)];
    const metric = "error_rate";
    const isAnomaly = Math.random() < 0.4;

    // Increment checksRun regardless (tracking uptime)
    const newChecksRun = this.state.checksRun + 1;

    if (!isAnomaly) {
      this.setState({
        checksRun: newChecksRun,
        incidents: this.state.incidents // unchanged
      });
      console.log(`Health check OK. Total checks: ${newChecksRun}`);
      return;
    }

    // ── ANOMALY DETECTED ──────────────────────────────────────────────

    const value = Math.floor(Math.random() * 60) + 10;
    const now = new Date();

    // 1. Compute the deterministic key
    const key = incidentKey(service, metric, now);

    // 2. Check if we already handled this exact incident
    if (this.state.incidents[key]) {
      // Dedup hit: skip the LLM entirely — saves neurons and prevents double-rollback
      console.log(
        `DEDUP HIT: ${key} already handled at ${this.state.incidents[key].detectedAt}. Skipping LLM.`
      );
      this.setState({
        checksRun: newChecksRun,
        incidents: this.state.incidents // unchanged
      });
      return;
    }

    // 3. New incident: run the full diagnose → policy → store flow
    const diagnosis = await this.diagnose(service, metric, value);
    const policy = applyPolicy(value, diagnosis.action);

    const incident: Incident = {
      key, // deterministic
      service,
      metric,
      value,
      detectedAt: now.toISOString(),
      recommendedAction: diagnosis.action,
      reasoning: diagnosis.reasoning,
      finalAction: policy.finalAction,
      policyOverride: policy.policyOverride
    };

    // 4. Store under the deterministic key (immutable update)
    this.setState({
      checksRun: newChecksRun,
      incidents: {
        ...this.state.incidents,
        [key]: incident
      }
    });

    console.log(
      `INCIDENT ${service} ${value}% | LLM: ${diagnosis.action} → FINAL: ${policy.finalAction}` +
        (policy.policyOverride ? " [POLICY OVERRIDE]" : "")
    );
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
