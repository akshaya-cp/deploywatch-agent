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
import { generateText } from "ai";


type Action = "retry" | "rollback" | "escalate";

type Incident = {
  id: string;
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
  incidents: Incident[];
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

export class ChatAgent extends AIChatAgent<Env, DeployWatchState>  {
  initialState: DeployWatchState = {
    checksRun: 0,
    incidents: []
  };
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    this.scheduleEvery(30, "runHealthCheck");
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

  async onChatMessage(onFinish: any, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
      system: `You are DeployWatch, a deployment reliability agent that monitors services for anomalies.

Only call getIncidentHistory when the user explicitly asks about incidents, services, errors, or what you have detected. For greetings or general questions, just reply conversationally without calling any tool.

When you do report incidents, summarize concisely: affected service, error rate, and the action taken.

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
          description: "Get the list of detected deployment incidents and the action taken for each",
          inputSchema: z.object({}),
          execute: async () => {
            const recent = this.state.incidents.slice(-10);
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
  ): Promise<{ action: Action; reasoning: string }> {
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

    const result = await this.env.AI.run(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      { messages: [{ role: "user", content: prompt }] }
    );

    const raw = (result as { response: unknown }).response;

    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw.trim()) : raw;
      return {
        action: parsed.action as Action,
        reasoning: parsed.reasoning as string
      };
    } catch {
      console.log("LLM returned unparseable output:", raw);
      return { action: "escalate", reasoning: "Could not parse LLM response" };
    }
  }

  
    async runHealthCheck() {
    const services = ["checkout-api", "auth-service", "payments-worker"];
    const service = services[Math.floor(Math.random() * services.length)];
    const metric = "error_rate";
    const isAnomaly = Math.random() < 0.4;

    if (isAnomaly) {
      const value = Math.floor(Math.random() * 60) + 10;

      const diagnosis = await this.diagnose(service, metric, value);
      const policy = applyPolicy(value, diagnosis.action);

      const incident: Incident = {
        id: crypto.randomUUID(),
        service,
        metric,
        value,
        detectedAt: new Date().toISOString(),
        recommendedAction: diagnosis.action,
        reasoning: diagnosis.reasoning,
        finalAction: policy.finalAction,
        policyOverride: policy.policyOverride
      };

      this.setState({
        checksRun: this.state.checksRun + 1,
        incidents: [...this.state.incidents, incident]
      });

      console.log(
        `INCIDENT ${service} ${value}% | LLM: ${diagnosis.action} → FINAL: ${policy.finalAction}` +
          (policy.policyOverride ? " [POLICY OVERRIDE]" : "")
      );
    } else {
      this.setState({
        checksRun: this.state.checksRun + 1,
        incidents: this.state.incidents
      });
      console.log("Health check OK. Total checks:", this.state.checksRun);
    }
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
