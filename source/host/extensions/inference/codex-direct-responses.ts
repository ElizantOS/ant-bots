type Loose = Record<string, any>;

function reportInferenceDebug(event: {
  readonly phase: string;
  readonly provider?: string;
  readonly toolName?: string;
  readonly step?: number;
  readonly toolCount?: number;
  readonly durationMs?: number;
  readonly firstTokenMs?: number;
  readonly outcome?: "ok" | "error";
}): void {
  const value = process.env.SAND_INFERENCE_DEBUG?.trim().toLowerCase();
  if (value !== "1" && value !== "true" && value !== "yes") return;
  try { process.stderr.write(`[sand:inference] ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`); } catch {}
}

const DEFAULT_DIRECT_TIMEOUT_MS = 60_000;

function configuredDirectTimeoutMs(env = process.env): number {
  const parsed = Number(env.SAND_CODEX_DIRECT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 600_000
    ? Math.floor(parsed)
    : DEFAULT_DIRECT_TIMEOUT_MS;
}

export type CodexDirectUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type CodexDirectTool = {
  readonly name: string;
  readonly description?: string;
  readonly parameters: unknown;
  readonly source: Loose;
};

export type CodexDirectEvent =
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call-streaming-start"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool-call-delta"; readonly toolCallId: string; readonly toolName: string; readonly argsTextDelta: string }
  | { readonly type: "tool-call"; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "done"; readonly text: string; readonly responseId: string; readonly usage: CodexDirectUsage; readonly toolCalls?: readonly { readonly toolCallId: string; readonly toolName: string; readonly args: unknown }[] };

export type CodexDirectOptions = {
  readonly fetch: typeof fetch;
  readonly endpoint: string;
  readonly authorization?: string;
  readonly accountId?: string;
  readonly model: string;
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  readonly instructions: string;
  readonly input: readonly Loose[];
  readonly tools?: readonly CodexDirectTool[];
  readonly executeTool?: (tool: CodexDirectTool, args: unknown, toolCallId: string) => Promise<unknown>;
  readonly maxSteps?: number;
};

function record(value: unknown): Loose | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Loose : null;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item) ?? "null"; }
  catch (error) { return JSON.stringify({ isError: true, error: error instanceof Error ? error.message : String(error) }); }
}

async function responseError(response: Response): Promise<Error> {
  let detail = "";
  try { detail = (await response.text()).slice(0, 4_096).trim(); } catch {}
  return new Error(`Codex direct request failed (${response.status}${detail.length === 0 ? "" : `: ${detail}`}).`);
}

async function* sseEvents(response: Response): AsyncGenerator<Loose> {
  if (response.body == null) throw new Error("Codex direct response did not include a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary).replaceAll("\r", "");
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      if (data.length === 0 || data === "[DONE]") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(data); }
      catch { throw new Error("Codex direct response contained malformed SSE JSON."); }
      const event = record(parsed);
      if (event != null) yield event;
    }
    if (done) break;
  }
  if (buffer.trim().length > 0 && buffer.trim() !== "data: [DONE]") throw new Error("Codex direct response ended with an incomplete SSE event.");
}

function usageOf(response: Loose): CodexDirectUsage {
  const usage = record(response.usage) ?? {};
  const details = record(usage.input_tokens_details) ?? {};
  return {
    inputTokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0,
    outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
    cacheReadTokens: Number.isFinite(details.cached_tokens) ? details.cached_tokens : 0,
    cacheWriteTokens: 0,
  };
}

function addUsage(total: CodexDirectUsage, next: CodexDirectUsage): CodexDirectUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + next.cacheWriteTokens,
  };
}

function toolCalls(output: readonly unknown[]): Loose[] {
  return output.flatMap(item => {
    const call = record(item);
    return call?.type === "function_call" && typeof call.name === "string" && typeof call.call_id === "string" ? [call] : [];
  });
}

function requestTools(tools: readonly CodexDirectTool[] | undefined): Loose[] | undefined {
  if (tools == null || tools.length === 0) return undefined;
  return tools.map(tool => ({
    type: "function",
    name: tool.name,
    ...(tool.description == null ? {} : { description: tool.description }),
    parameters: tool.parameters,
    strict: false,
  }));
}

export async function* streamCodexDirectResponses(options: CodexDirectOptions): AsyncGenerator<CodexDirectEvent> {
  const maxSteps = options.maxSteps ?? 8;
  const toolsByName = new Map((options.tools ?? []).map(tool => [tool.name, tool]));
  let input: Loose[] = options.input.map(item => ({ ...item }));
  let text = "";
  let responseId = "";
  let usage: CodexDirectUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    const declaredTools = requestTools(options.tools);
    const requestStartedAt = performance.now();
    const timeoutMs = configuredDirectTimeoutMs();
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await options.fetch(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "user-agent": "grok-bot-router/1",
          ...(options.authorization == null ? {} : { authorization: options.authorization }),
          ...(options.accountId == null ? {} : { "ChatGPT-Account-Id": options.accountId }),
        },
        signal,
        body: JSON.stringify({
          model: options.model,
          instructions: options.instructions,
          input,
          ...(declaredTools == null ? {} : { tools: declaredTools, tool_choice: "auto", parallel_tool_calls: true }),
          ...(options.reasoningEffort == null ? {} : { reasoning: { effort: options.reasoningEffort, summary: "auto" } }),
          include: ["reasoning.encrypted_content"],
          stream: true,
          store: false,
        }),
      });
    } catch (error) {
      reportInferenceDebug({ provider: "codex", phase: "model", step: step + 1, durationMs: Math.round(performance.now() - requestStartedAt), outcome: "error" });
      if (signal.aborted) throw new Error(`Codex direct request timed out after ${timeoutMs}ms.`);
      throw error;
    }
    if (!response.ok) throw await responseError(response);

    let completed: Loose | null = null;
    const observedOutput: Loose[] = [];
    let firstTokenMs: number | undefined;
    try {
      for await (const event of sseEvents(response)) {
        if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          firstTokenMs ??= performance.now() - requestStartedAt;
          text += event.delta;
          yield { type: "text-delta", delta: event.delta };
        } else if (event.type === "response.output_item.done") {
          const item = record(event.item);
          if (item != null) observedOutput.push(item);
        } else if (event.type === "response.completed") {
          completed = record(event.response);
        } else if (event.type === "response.failed" || event.type === "error") {
          const failure = record(event.response)?.error ?? event.error ?? event;
          throw new Error(`Codex direct response failed: ${safeJson(failure).slice(0, 4_096)}`);
        }
      }
    } catch (error) {
      if (signal.aborted) {
        reportInferenceDebug({ provider: "codex", phase: "model", step: step + 1, durationMs: Math.round(performance.now() - requestStartedAt), outcome: "error" });
        throw new Error(`Codex direct request timed out after ${timeoutMs}ms.`);
      }
      throw error;
    }
    if (completed == null) throw new Error("Codex direct response ended without response.completed.");
    if (typeof completed.id === "string") responseId = completed.id;
    usage = addUsage(usage, usageOf(completed));
    const output = Array.isArray(completed.output) && completed.output.length > 0 ? completed.output : observedOutput;
    const calls = toolCalls(output);
    reportInferenceDebug({ provider: "codex", phase: "model", step: step + 1, durationMs: Math.round(performance.now() - requestStartedAt), ...(firstTokenMs === undefined ? {} : { firstTokenMs: Math.round(firstTokenMs) }), toolCount: calls.length, outcome: "ok" });
    if (calls.length === 0) {
      yield { type: "done", text, responseId, usage };
      return;
    }
    const executeTool = options.executeTool;
    if (executeTool == null) {
      const streamedCalls = [];
      for (const call of calls) {
        const rawArgs = typeof call.arguments === "string" && call.arguments.length > 0 ? call.arguments : "{}";
        let args: unknown = rawArgs;
        try { args = JSON.parse(rawArgs); } catch {}
        const toolCall = { toolCallId: call.call_id, toolName: call.name, args };
        streamedCalls.push(toolCall);
        yield { type: "tool-call-streaming-start", toolCallId: call.call_id, toolName: call.name };
        yield { type: "tool-call-delta", toolCallId: call.call_id, toolName: call.name, argsTextDelta: rawArgs };
        yield { type: "tool-call", toolCallId: call.call_id, toolName: call.name, args };
      }
      yield { type: "done", text, responseId, usage, toolCalls: streamedCalls };
      return;
    }

    const executeCall = async (call: Loose): Promise<Loose> => {
      const selected = toolsByName.get(call.name);
      if (selected == null) {
        reportInferenceDebug({ provider: "codex", phase: "tool", toolName: call.name, durationMs: 0, outcome: "error" });
        return { type: "function_call_output", call_id: call.call_id, output: safeJson({ isError: true, error: `Unknown Grok Bot tool: ${call.name}` }) };
      }
      let args: unknown = {};
      try { args = typeof call.arguments === "string" && call.arguments.length > 0 ? JSON.parse(call.arguments) : {}; }
      catch {
        reportInferenceDebug({ provider: "codex", phase: "tool", toolName: call.name, durationMs: 0, outcome: "error" });
        return { type: "function_call_output", call_id: call.call_id, output: safeJson({ isError: true, error: "Tool arguments were not valid JSON." }) };
      }
      const toolStartedAt = performance.now();
      try {
        const value = await executeTool(selected, args, call.call_id);
        reportInferenceDebug({ provider: "codex", phase: "tool", toolName: call.name, durationMs: Math.round(performance.now() - toolStartedAt), outcome: "ok" });
        return { type: "function_call_output", call_id: call.call_id, output: safeJson(value) };
      } catch (error) {
        reportInferenceDebug({ provider: "codex", phase: "tool", toolName: call.name, durationMs: Math.round(performance.now() - toolStartedAt), outcome: "error" });
        return { type: "function_call_output", call_id: call.call_id, output: safeJson({ isError: true, error: error instanceof Error ? error.message : String(error) }) };
      }
    };
    // The request explicitly enables parallel tool calls. Preserve output order
    // while allowing independent connector calls to overlap.
    const results = await Promise.all(calls.map(executeCall));
    input = [...input, ...output.map(item => record(item) ?? {}), ...results];
  }
  throw new Error(`Codex exceeded Grok Bot's ${maxSteps}-step tool limit.`);
}
