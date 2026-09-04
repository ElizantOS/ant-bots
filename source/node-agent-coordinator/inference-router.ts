import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runRoutedProviderText } from "../host/extensions/inference/provider-session.js";
import { reportInferenceDebug } from "../shared/inference-diagnostics.js";
import { ROUTED_AGENT_TOOL_PROVIDER } from "../shared/routed-agent-tools.js";
import { isSandInferenceProvider, type SandInferenceProvider } from "../shared/inference-router.js";
import { resolveCursorAgentCliPath, resolveOpenCodeCliPath } from "../shared/node/inference-router-local.js";
import { SandSettingsStore } from "../shared/node/settings/sand-settings-store.js";
import { createRoutedMcpBridge } from "./routed-mcp-bridge.js";

type StoredEntry = {
  readonly provider: SandInferenceProvider;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly richText?: string;
  readonly id: string;
  readonly clientNonce?: string;
  readonly reactions?: readonly { readonly emoji: string; readonly by: string }[];
  readonly timestampMs: number;
};
type Store = { readonly schemaVersion: 2; readonly agents: Readonly<Record<string, readonly StoredEntry[]>> };

const EMPTY_STORE: Store = { schemaVersion: 2, agents: {} };
const ROUTED_TOOL_CATALOG_TTL_MS = 10_000;
const ROUTED_ROSTER_TTL_MS = 3_000;
const ROUTED_CONTEXT_MESSAGE_LIMIT = 80;
const ACTIVITY_PULSE_MS = 1_000;
const BOX_READ_FALLBACK_TIMEOUT_MS = 2_500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function transcriptTime(value: unknown): number | null {
  const row = asRecord(value);
  const composed = row?.composedAtMs ?? row?.queuedAtMs;
  if (typeof composed === "number" && Number.isFinite(composed)) return composed;
  return typeof row?.timestampMs === "number" && Number.isFinite(row.timestampMs) ? row.timestampMs : null;
}

function transcriptTurnOrder(value: unknown): [number, number] | null {
  const id = asRecord(value)?.id;
  if (typeof id !== "string") return null;
  const match = /^t(\d+)(u|s(\d+))$/.exec(id);
  if (match == null) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) && turn >= 0 && turn < 1_000_000_000
    ? [turn, match[2] === "u" ? 0 : 1 + Number(match[3] ?? 0)]
    : null;
}

/** Merge remote and locally-routed transcript rows without arrival-order loss. */
function mergeRoutedTranscriptEntries(
  primary: readonly unknown[],
  secondary: readonly unknown[],
): unknown[] {
  const merged = new Map<string, { readonly value: unknown; readonly position: number }>();
  const anonymous: { readonly value: unknown; readonly position: number }[] = [];
  let position = 0;
  const add = (value: unknown): void => {
    const id = asRecord(value)?.id;
    if (typeof id !== "string" || id.length === 0) anonymous.push({ value, position: position++ });
    else {
      const previous = merged.get(id);
      merged.set(id, { value, position: previous?.position ?? position });
      position += 1;
    }
  };
  primary.forEach(add);
  secondary.forEach(add);
  return [...merged.values(), ...anonymous]
    .sort((left, right) => {
      const leftTime = transcriptTime(left.value);
      const rightTime = transcriptTime(right.value);
      if (leftTime != null && rightTime != null && leftTime !== rightTime) return leftTime - rightTime;
      const leftTurn = transcriptTurnOrder(left.value);
      const rightTurn = transcriptTurnOrder(right.value);
      if (leftTurn != null && rightTurn != null && (leftTurn[0] !== rightTurn[0] || leftTurn[1] !== rightTurn[1])) {
        return leftTurn[0] - rightTurn[0] || leftTurn[1] - rightTurn[1];
      }
      if (leftTime == null && rightTime != null) return 1;
      if (leftTime != null && rightTime == null) return -1;
      return left.position - right.position;
    })
    .map(({ value }) => value);
}

export function parseInferenceRouterTranscriptStore(value: unknown): Store {
  const root = asRecord(value);
  if (root?.schemaVersion !== 2 || asRecord(root.agents) == null) return EMPTY_STORE;
  const agents: Record<string, StoredEntry[]> = {};
  for (const [agentId, rawEntries] of Object.entries(root.agents as Record<string, unknown>)) {
    if (!Array.isArray(rawEntries)) continue;
    const entries: StoredEntry[] = [];
    for (const raw of rawEntries) {
      const row = asRecord(raw);
      if (row == null || !isSandInferenceProvider(row.provider) || !["user", "assistant"].includes(String(row.role)) || typeof row.content !== "string" || typeof row.id !== "string" || typeof row.timestampMs !== "number" || (row.clientNonce !== undefined && typeof row.clientNonce !== "string") || (row.richText !== undefined && typeof row.richText !== "string")) continue;
      if (row.reactions !== undefined && (!Array.isArray(row.reactions) || row.reactions.some(reaction => asRecord(reaction) == null || typeof asRecord(reaction)!.emoji !== "string" || typeof asRecord(reaction)!.by !== "string"))) continue;
      entries.push(row as unknown as StoredEntry);
    }
    agents[agentId] = entries.slice(-200);
  }
  return { schemaVersion: 2, agents };
}

export function projectInferenceRouterTranscriptEntry(entry: StoredEntry): Record<string, unknown> {
  return entry.role === "user"
    ? { kind: "message", id: entry.id, role: "user", content: entry.content, routed: true, ...(entry.richText === undefined ? {} : { richText: entry.richText }), isStreaming: false, timestampMs: entry.timestampMs, ...(entry.clientNonce === undefined ? {} : { clientNonce: entry.clientNonce }), ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) }
    : { kind: "send-message", id: entry.id, message: { type: "text", content: entry.content }, routed: true, timestampMs: entry.timestampMs, ...(entry.reactions === undefined ? {} : { reactions: entry.reactions }) };
}

type RoutedTool = Record<string, unknown>;
const ROUTED_USER_TOOL_PROVIDER = "grok-bot-user-tools";
const ROUTED_SEND_MESSAGE_TOOL: RoutedTool = {
  providerIdentifier: ROUTED_USER_TOOL_PROVIDER,
  name: "SendMessage",
  toolName: "SendMessage",
  description: "Say something to the user in the Grok Bot chat. This is your only voice. Use type=text with content for normal replies. The user only sees messages sent through this tool.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["text", "attachment", "widget", "cursor-agent", "secret-request"] },
      content: { type: "string", description: "The message to show to the user. Required for type=text." },
      url: { type: "string", description: "The file:// or https:// URL for type=attachment." },
      alt: { type: "string", description: "Optional attachment description." },
      images: { type: "array", items: { type: "object", properties: { url: { type: "string" }, alt: { type: "string" } }, required: ["url"], additionalProperties: false } },
      reply_to: { type: "string" },
      channel: { type: "string" },
      widget: { type: "object", additionalProperties: true },
      bcId: { type: "string" },
      secret: { type: "object", additionalProperties: true },
    },
    required: ["type"],
    additionalProperties: false,
  },
};
type ToolCacheEntry = {
  readonly value?: readonly RoutedTool[];
  readonly expiresAt: number;
  readonly promise?: Promise<readonly RoutedTool[]>;
};
type RosterCacheEntry = {
  readonly value?: readonly Record<string, unknown>[];
  readonly expiresAt: number;
  readonly promise?: Promise<readonly Record<string, unknown>[]>;
};

function normalizeRoutedTools(value: unknown): readonly RoutedTool[] {
  return Array.isArray(value)
    ? value.filter((item): item is RoutedTool => asRecord(item) != null) as RoutedTool[]
    : [];
}

/**
 * External provider turns are local and remain useful while the optional box
 * is reconnecting. Bound box-backed reads so a dead gateway cannot hold the
 * provider's critical path; callers receive a conservative local fallback.
 */
function readBoxWithFallback<Value>(request: Promise<Value>, fallback: Value, timeoutMs = BOX_READ_FALLBACK_TIMEOUT_MS): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Value>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([request.catch(() => fallback), deadline]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

function withoutAskAgent(tools: readonly RoutedTool[]): RoutedTool[] {
  return tools.filter((tool) => tool.name !== "AskAgent" && tool.toolName !== "AskAgent");
}

function localAgentProfile(agent: Record<string, unknown>): Record<string, unknown> {
  return {
    id: agent.id,
    name: typeof agent.name === "string" && agent.name.trim().length > 0 ? agent.name : "New chat",
    ...(typeof agent.description === "string" ? { description: agent.description } : {}),
  };
}

/**
 * Read-only routed agent tools can use the last roster while the gateway is
 * reconnecting. Mutating tools deliberately have no local fallback.
 */
export function fallbackRoutedAgentRead(
  toolName: unknown,
  sourceAgentId: string,
  roster: readonly Record<string, unknown>[] | undefined,
): unknown | undefined {
  if (roster == null || (toolName !== "ListAgents" && toolName !== "ListGroups")) return undefined;
  const source = roster.find(agent => agent.id === sourceAgentId);
  if (source == null || source.isGroup === true || source.remoteRoom != null) return undefined;
  if (toolName === "ListAgents") {
    return roster
      .filter(agent => agent.id !== sourceAgentId && agent.isGroup !== true && agent.remoteRoom == null)
      .map(localAgentProfile);
  }
  return roster
    .filter(agent => agent.isGroup === true && Array.isArray(agent.memberIds) && agent.memberIds.includes(sourceAgentId))
    .map(group => ({
      id: group.id,
      name: typeof group.name === "string" && group.name.trim().length > 0 ? group.name : "Group",
      ...(typeof group.description === "string" ? { description: group.description } : {}),
      members: (group.memberIds as unknown[])
        .filter(memberId => memberId !== sourceAgentId)
        .map(memberId => roster.find(agent => agent.id === memberId))
        .filter((agent): agent is Record<string, unknown> => agent != null)
        .map(localAgentProfile),
    }));
}

export function createCoordinatorInferenceRouter(options: {
  readonly dataDir: string;
  readonly postEvent: (family: string, payload: unknown) => void;
  readonly dispatchRemote: (method: string, args: unknown) => Promise<unknown>;
  readonly now?: () => number;
}) {
  const settings = new SandSettingsStore(join(options.dataDir, "settings.json"));
  const storePath = join(options.dataDir, "inference-router-transcript.json");
  const now = options.now ?? Date.now;
  const queues = new Map<string, Promise<unknown>>();
  const askQueues = new Map<string, Promise<string>>();
  const toolCache = new Map<string, ToolCacheEntry>();
  let rosterCache: RosterCacheEntry | undefined;
  let staleRoster: readonly Record<string, unknown>[] | undefined;
  let storeMutationQueue: Promise<void> = Promise.resolve();
  let storeSnapshot: Store | undefined;
  let storeLoadPromise: Promise<Store> | undefined;

  const load = (): Promise<Store> => {
    if (storeSnapshot !== undefined) return Promise.resolve(storeSnapshot);
    if (storeLoadPromise !== undefined) return storeLoadPromise;
    const promise = readFile(storePath, "utf8").then((contents) => {
      if (storeSnapshot === undefined) storeSnapshot = parseInferenceRouterTranscriptStore(JSON.parse(contents));
      return storeSnapshot;
    }).catch(() => {
      storeSnapshot ??= EMPTY_STORE;
      return storeSnapshot;
    });
    storeLoadPromise = promise;
    void promise.finally(() => {
      if (storeLoadPromise === promise) storeLoadPromise = undefined;
    }).catch(() => {});
    return promise;
  };
  const persist = async (store: Store): Promise<void> => {
    await mkdir(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, storePath);
    storeSnapshot = store;
  };
  const mutateStore = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = storeMutationQueue.then(operation, operation);
    storeMutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };
  const append = (agentId: string, entries: readonly StoredEntry[]): Promise<Store> => mutateStore(async () => {
    const current = await load();
    const next: Store = { schemaVersion: 2, agents: { ...current.agents, [agentId]: [...(current.agents[agentId] ?? []), ...entries].slice(-200) } };
    await persist(next);
    return next;
  });
  const emitTranscript = (agentId: string, type: "appended" | "updated", entry: Record<string, unknown>) => options.postEvent("transcript", { type, entry, agentId });

  const decorateTranscriptEvent = (payload: unknown): unknown => {
    const event = asRecord(payload);
    if (event?.type !== "snapshot" || typeof event.activeAgentId !== "string" || !Array.isArray(event.entries)) return payload;
    const local = storeSnapshot?.agents[event.activeAgentId] ?? [];
    return {
      ...event,
      entries: mergeRoutedTranscriptEntries(event.entries, local.map(projectInferenceRouterTranscriptEntry)),
    };
  };

  const providerMessages = (values: readonly unknown[]): { role: "user" | "assistant"; content: string }[] => values.flatMap((raw) => {
    const row = asRecord(raw);
    if (row == null) return [];
    if ((row.role === "user" || row.role === "assistant") && typeof row.content === "string") {
      return [{ role: row.role, content: row.content }];
    }
    if (row.kind === "message" && row.role === "user" && typeof row.content === "string") {
      return [{ role: "user", content: row.content }];
    }
    if (row.kind === "send-message") {
      const message = asRecord(row.message);
      if (message?.type === "text" && typeof message.content === "string") {
        return [{ role: "assistant", content: message.content }];
      }
    }
    return [];
  });

  const entryIdTurn = (value: unknown): number => {
    const id = asRecord(value)?.id;
    const match = typeof id === "string" ? /^t(\d+)(?:u|s\d+)$/.exec(id) : null;
    const turn = match == null ? -1 : Number(match[1]);
    return Number.isSafeInteger(turn) && turn >= 0 && turn < 1_000_000_000 ? turn : -1;
  };

  const nextTurnFor = (remoteEntries: readonly unknown[], localEntries: readonly StoredEntry[]): number => Math.max(
    remoteEntries.reduce<number>((highest, entry) => Math.max(highest, entryIdTurn(entry)), -1),
    localEntries.reduce<number>((highest, entry) => Math.max(highest, entryIdTurn(entry)), -1),
  ) + 1;

  const rosterRow = (value: unknown): Record<string, unknown> | null => {
    const row = asRecord(value);
    return row == null || typeof row.id !== "string" ? null : row;
  };
  const listRoster = (force = false): Promise<readonly Record<string, unknown>[]> => {
    if (!force && rosterCache?.value !== undefined && rosterCache.expiresAt > now()) return Promise.resolve(rosterCache.value);
    if (rosterCache?.promise !== undefined) return rosterCache.promise;
    const startedAt = performance.now();
    const promise = options.dispatchRemote("listAgents", {}).then((value) => {
      const roster = Array.isArray(value)
        ? value.map(rosterRow).filter((row): row is Record<string, unknown> => row != null)
        : [];
      staleRoster = roster;
      rosterCache = { value: roster, expiresAt: now() + ROUTED_ROSTER_TTL_MS };
      reportInferenceDebug({ phase: "roster", durationMs: Math.round(performance.now() - startedAt), toolCount: roster.length, outcome: "ok" });
      return roster;
    }).catch((error) => {
      rosterCache = undefined;
      reportInferenceDebug({ phase: "roster", durationMs: Math.round(performance.now() - startedAt), outcome: "error" });
      throw error;
    });
    rosterCache = {
      ...(rosterCache?.value === undefined ? {} : { value: rosterCache.value }),
      expiresAt: rosterCache?.expiresAt ?? 0,
      promise,
    };
    void promise.finally(() => {
      if (rosterCache?.promise !== promise) return;
      rosterCache = { ...(rosterCache.value === undefined ? {} : { value: rosterCache.value }), expiresAt: rosterCache.expiresAt };
    }).catch(() => {});
    return promise;
  };
  const invalidateRoster = (): void => { rosterCache = undefined; };
  void load().catch(() => {});
  const beginActivity = async (agentId: string): Promise<() => void> => {
    try {
      const remote = await listRoster();
      const project = (isRunning: boolean) => remote.map(row => {
        if (row.id !== agentId) return row;
        return { ...row, isRunning, isRunningTurn: isRunning, isComposingMessage: isRunning, isRetrying: false, ...(isRunning ? { currentActivity: { kind: "thinking" } } : { currentActivity: undefined }) };
      });
      const publishRunning = () => options.postEvent("agents", { activeAgentId: agentId, agents: project(true) });
      publishRunning();
      // Transcript refreshes can fetch the remote (idle) roster while a local CLI turn is
      // running. Pulse the locally authoritative state until the turn settles so those
      // refreshes cannot permanently erase the polished renderer's activity surface.
      const pulse = setInterval(publishRunning, ACTIVITY_PULSE_MS);
      pulse.unref();
      return () => {
        clearInterval(pulse);
        options.postEvent("agents", { activeAgentId: agentId, agents: project(false) });
      };
    } catch { return () => {}; }
  };

  const loadCachedTools = (key: string, loader: () => Promise<unknown>): Promise<readonly RoutedTool[]> => {
    const current = toolCache.get(key);
    if (current?.value !== undefined && current.expiresAt > now()) return Promise.resolve(current.value);
    if (current?.promise !== undefined) return current.promise;
    const startedAt = performance.now();
    const promise = loader().then(normalizeRoutedTools).then((value) => {
      toolCache.set(key, { value, expiresAt: now() + ROUTED_TOOL_CATALOG_TTL_MS });
      reportInferenceDebug({ phase: "tool-catalog", durationMs: Math.round(performance.now() - startedAt), toolCount: value.length, outcome: "ok" });
      return value;
    }).catch((error) => {
      toolCache.delete(key);
      reportInferenceDebug({ phase: "tool-catalog", durationMs: Math.round(performance.now() - startedAt), outcome: "error" });
      throw error;
    });
    toolCache.set(key, {
      ...(current?.value === undefined ? {} : { value: current.value }),
      expiresAt: current?.expiresAt ?? 0,
      promise,
    });
    void promise.finally(() => {
      const entry = toolCache.get(key);
      if (entry?.promise === promise) {
        toolCache.set(key, {
          ...(entry.value === undefined ? {} : { value: entry.value }),
          expiresAt: entry.expiresAt,
        });
      }
    }).catch(() => {});
    return promise;
  };

  const listRoutedTools = async (agentId: string, includeAskAgent = true, includeSendMessage = true): Promise<RoutedTool[]> => {
    const [mcp, agent] = await Promise.all([
      loadCachedTools("mcp", () => readBoxWithFallback(options.dispatchRemote("listRoutedMcpTools", {}), [])),
      loadCachedTools(`agent:${agentId}`, () => readBoxWithFallback(options.dispatchRemote("listRoutedAgentTools", { agentId }), [])),
    ]);
    const tools = [...mcp, ...agent, ...(includeSendMessage ? [ROUTED_SEND_MESSAGE_TOOL] : [])];
    return includeAskAgent ? tools as RoutedTool[] : withoutAskAgent(tools);
  };

  const shouldUseCodexCliMcp = (provider: SandInferenceProvider): boolean =>
    provider === "codex" && process.env.SAND_CODEX_MCP_MODE?.trim().toLowerCase() === "cli";

  const shouldUseCursorAgentCli = (provider: SandInferenceProvider): boolean =>
    provider === "cursor" && resolveCursorAgentCliPath() != null;

  const shouldUseOpenCodeCli = (provider: SandInferenceProvider): boolean =>
    provider === "opencode" && resolveOpenCodeCliPath() != null;

  const createProviderBridge = async (
    provider: SandInferenceProvider,
    tools: readonly RoutedTool[],
    callTool: (tool: RoutedTool & { readonly args: unknown; readonly toolCallId: string }) => Promise<unknown>,
  ) => {
    if (provider !== "claude-code" && !shouldUseCodexCliMcp(provider) && !shouldUseCursorAgentCli(provider) && !shouldUseOpenCodeCli(provider)) return null;
    return await createRoutedMcpBridge({
      initialTools: tools,
      listTools: async () => tools,
      callTool,
    });
  };

  async function runAgentQuestion(
    provider: SandInferenceProvider,
    fromAgentId: string,
    targetAgentId: string,
    question: string,
    parentClientNonce: string,
  ): Promise<string> {
    const previous = askQueues.get(targetAgentId) ?? Promise.resolve("");
    const next = previous.catch(() => "").then(async () => {
      const roster = await listRoster(true);
      const source = roster.find((agent) => agent.id === fromAgentId);
      const target = roster.find((agent) => agent.id === targetAgentId);
      if (source == null) throw new Error(`No local agent found with id ${fromAgentId}.`);
      if (target == null) throw new Error(`No agent found with id ${targetAgentId}.`);
      if (targetAgentId === fromAgentId) throw new Error("An agent can't ask itself.");
      if (target.isGroup === true) throw new Error("AskAgent only works with a single agent, not a group.");
      if (target.remoteRoom != null) throw new Error("AskAgent cannot query a shared chat hosted by another user.");

      const remote = await options.dispatchRemote("getAgentTranscriptTail", { id: targetAgentId, limit: 200 });
      const remoteEntries = Array.isArray(asRecord(remote)?.entries)
        ? asRecord(remote)!.entries as unknown[]
        : [];
      const before = await load();
      const localEntries = before.agents[targetAgentId] ?? [];
      const history = mergeRoutedTranscriptEntries(remoteEntries, localEntries);
      const turn = nextTurnFor(remoteEntries, localEntries);
      const timestampMs = now();
      const clientNonce = `ask-${parentClientNonce}-${randomUUID()}`;
      const userEntry = {
        kind: "message",
        id: `t${turn}u`,
        role: "user",
        content: question,
        routed: true,
        isStreaming: false,
        timestampMs,
        clientNonce,
      };
      await append(targetAgentId, [{ provider, role: "user", content: question, id: userEntry.id, clientNonce, timestampMs }]);
      emitTranscript(targetAgentId, "appended", userEntry);

      const targetMessages = [...providerMessages(history), ...providerMessages([userEntry])].slice(-ROUTED_CONTEXT_MESSAGE_LIMIT);
      const tools = await listRoutedTools(targetAgentId, false, false);
      const assistantId = `t${turn}s0`;
      const assistantTimestampMs = now();
      let assistantStreamStarted = false;
      const emitAssistant = (content: string, streaming: boolean) => {
        emitTranscript(targetAgentId, assistantStreamStarted ? "updated" : "appended", {
          kind: "send-message",
          id: assistantId,
          message: { type: "text", content },
          routed: true,
          streaming,
          timestampMs: assistantTimestampMs,
        });
        assistantStreamStarted = true;
      };
      const dispatchTargetTool = (definition: Record<string, unknown>, toolArgs: unknown, toolCallId: string) => dispatchRoutedTool(
        provider,
        targetAgentId,
        clientNonce,
        definition,
        toolArgs,
        toolCallId,
        false,
      );
      const bridge = await createProviderBridge(
        provider,
        tools,
        (tool) => dispatchTargetTool(tool, tool.args, tool.toolCallId),
      );
      const sourceName = typeof source.name === "string" ? source.name : "another Bot";
      const targetName = typeof target.name === "string" ? target.name : "the target Bot";
      const targetDescription = typeof target.description === "string" && target.description.trim().length > 0
        ? ` Your persona is: ${target.description.trim()}`
        : "";
      const systemPromptAddition = `You are answering a synchronous question from ${sourceName} (agent id ${fromAgentId}) through AskAgent. You are ${targetName}.${targetDescription} Return a useful answer as ordinary text; it is sent back to the asking Bot, not directly to the user. Do not call AskAgent or wait for another Bot. You may use the other supplied tools when needed, then give the answer.`;
      try {
        const content = await runRoutedProviderText(provider, targetMessages, bridge == null ? {
          tools,
          executeTool: dispatchTargetTool,
          onTextDelta: (_delta, accumulated) => emitAssistant(accumulated, true),
          systemPromptAddition,
        } : {
          mcpServerUrl: bridge.url,
          tools,
          executeTool: dispatchTargetTool,
          onTextDelta: (_delta, accumulated) => emitAssistant(accumulated, true),
          systemPromptAddition,
        });
        const answer = content.trim().length > 0
          ? content.trim()
          : "The agent completed the request but did not return a text answer.";
        await append(targetAgentId, [{ provider, role: "assistant", content: answer, id: assistantId, timestampMs: assistantTimestampMs }]);
        emitAssistant(answer, false);
        return answer;
      } finally {
        await bridge?.close();
      }
    });
    askQueues.set(targetAgentId, next);
    try {
      return await next;
    } finally {
      if (askQueues.get(targetAgentId) === next) askQueues.delete(targetAgentId);
    }
  }

  async function dispatchRoutedTool(
    provider: SandInferenceProvider,
    agentId: string,
    clientNonce: string,
    definition: Record<string, unknown>,
    toolArgs: unknown,
    toolCallId: string,
    allowAskAgent = true,
    sendUserMessage?: (message: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown> {
    const startedAt = performance.now();
    try {
      let result: unknown;
      if (definition.providerIdentifier === ROUTED_USER_TOOL_PROVIDER
        && (definition.name === "SendMessage" || definition.toolName === "SendMessage")) {
        if (sendUserMessage == null) throw new Error("SendMessage is unavailable in this routed turn.");
        const args = asRecord(toolArgs);
        if (args == null || args.type !== "text" || typeof args.content !== "string" || args.content.trim().length === 0) {
          throw new Error("Routed SendMessage currently supports only type=text with non-empty content.");
        }
        result = await sendUserMessage({ type: "text", content: args.content.trim() });
      } else if (definition.providerIdentifier === ROUTED_AGENT_TOOL_PROVIDER
        && (definition.name === "AskAgent" || definition.toolName === "AskAgent")) {
        if (!allowAskAgent) throw new Error("AskAgent cannot be nested.");
        const args = asRecord(toolArgs);
        const targetId = typeof args?.target_id === "string" ? args.target_id.trim() : "";
        const question = typeof args?.question === "string" ? args.question.trim() : "";
        if (targetId.length === 0 || question.length === 0) throw new Error("AskAgent requires target_id and question.");
        result = await runAgentQuestion(provider, agentId, targetId, question, clientNonce || toolCallId);
      } else {
        try {
          result = await options.dispatchRemote(
            definition.providerIdentifier === ROUTED_AGENT_TOOL_PROVIDER
              ? "executeRoutedAgentTool"
              : "executeRoutedMcpTool",
            { ...definition, args: toolArgs, toolCallId, agentId, clientNonce },
          );
        } catch (error) {
          const fallback = definition.providerIdentifier === ROUTED_AGENT_TOOL_PROVIDER
            ? fallbackRoutedAgentRead(definition.name ?? definition.toolName, agentId, staleRoster)
            : undefined;
          if (fallback === undefined) throw error;
          result = fallback;
          reportInferenceDebug({ provider, phase: "routed-tool-fallback", agentId, ...(typeof definition.name === "string" ? { toolName: definition.name } : {}), durationMs: Math.round(performance.now() - startedAt), outcome: "ok" });
        }
      }
      if (definition.providerIdentifier === ROUTED_AGENT_TOOL_PROVIDER
        && (definition.name === "CreateAgent" || definition.toolName === "CreateAgent" || definition.name === "UpdateAgent" || definition.toolName === "UpdateAgent")) {
        invalidateRoster();
      }
      reportInferenceDebug({ provider, phase: "routed-tool", agentId, ...(typeof definition.name === "string" ? { toolName: definition.name } : {}), durationMs: Math.round(performance.now() - startedAt), outcome: "ok" });
      return result;
    } catch (error) {
      reportInferenceDebug({ provider, phase: "routed-tool", agentId, ...(typeof definition.name === "string" ? { toolName: definition.name } : {}), durationMs: Math.round(performance.now() - startedAt), outcome: "error" });
      throw error;
    }
  }
  const toggleLocalReaction = async (agentId: string, entryId: string, emoji: string): Promise<Record<string, unknown> | null> => {
    const trimmed = emoji.trim();
    if (agentId.length === 0 || entryId.length === 0 || trimmed.length === 0) return null;
    return await mutateStore(async () => {
      const current = await load();
      const entries = current.agents[agentId];
      if (entries == null) return null;
      const index = entries.findIndex(entry => entry.id === entryId);
      if (index < 0) return null;
      const before = entries[index]!;
      const reactions = before.reactions ?? [];
      const exists = reactions.some(reaction => reaction.emoji === trimmed && reaction.by === "me");
      const nextReactions = exists ? reactions.filter(reaction => !(reaction.emoji === trimmed && reaction.by === "me")) : [...reactions, { emoji: trimmed, by: "me" }];
      const { reactions: _oldReactions, ...withoutReactions } = before;
      const updated: StoredEntry = nextReactions.length === 0 ? withoutReactions : { ...withoutReactions, reactions: nextReactions };
      const nextEntries = [...entries];
      nextEntries[index] = updated;
      await persist({ schemaVersion: 2, agents: { ...current.agents, [agentId]: nextEntries } });
      return projectInferenceRouterTranscriptEntry(updated);
    });
  };
  const execute = async (provider: SandInferenceProvider, args: Record<string, unknown>) => {
    const turnStartedAt = performance.now();
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const richText = typeof args.richText === "string" ? args.richText : undefined;
    const clientNonce = typeof args.clientNonce === "string" ? args.clientNonce : randomUUID();
    if (agentId.length === 0 || prompt.length === 0) throw new Error("Local inference routing requires an agentId and prompt");
    const timestampMs = now();
    const activityPromise = beginActivity(agentId);
    let activityEnded = false;
    let endActivity: () => void = () => {};
    void activityPromise.then((stop) => {
      if (activityEnded) stop();
      else endActivity = stop;
    }).catch(() => {});
    const finishActivity = (): void => {
      if (activityEnded) return;
      activityEnded = true;
      endActivity();
    };
    let remote: unknown;
    let beforeUser: Store;
    let tools: RoutedTool[];
    const prepareStartedAt = performance.now();
    try {
      [remote, beforeUser, tools] = await Promise.all([
        readBoxWithFallback(options.dispatchRemote("getAgentTranscriptTail", { id: agentId }), { entries: [] }),
        load(),
        listRoutedTools(agentId),
      ]);
      reportInferenceDebug({ provider, phase: "prepare", agentId, durationMs: Math.round(performance.now() - prepareStartedAt), toolCount: tools.length, outcome: "ok" });
    } catch (error) {
      finishActivity();
      reportInferenceDebug({ provider, phase: "prepare", agentId, durationMs: Math.round(performance.now() - prepareStartedAt), outcome: "error" });
      throw error;
    }
    const remoteEntries = Array.isArray(asRecord(remote)?.entries) ? asRecord(remote)!.entries as unknown[] : [];
    const remoteTurn = remoteEntries.reduce<number>((highest, raw) => {
      const id = asRecord(raw)?.id;
      const match = typeof id === "string" ? /^t(\d+)(?:u|s\d+)$/.exec(id) : null;
      return match == null ? highest : Math.max(highest, Number(match[1]));
    }, -1);
    const localTurn = (beforeUser.agents[agentId] ?? []).reduce((highest, entry) => {
      return Math.max(highest, entryIdTurn(entry));
    }, -1);
    const turn = Math.max(remoteTurn, localTurn) + 1;
    const userEntry = { kind: "message", id: `t${turn}u`, role: "user", content: prompt, routed: true, ...(richText === undefined ? {} : { richText }), isStreaming: false, timestampMs, clientNonce };
    const withUser = await append(agentId, [{ provider, role: "user", content: prompt, ...(richText === undefined ? {} : { richText }), id: userEntry.id, clientNonce, timestampMs }]);
    emitTranscript(agentId, "appended", userEntry);
    // Activity roster publication is best-effort and stays off the provider's
    // critical path. A slow disk scan must not delay the first model request.
    const messages = (withUser.agents[agentId] ?? []).map(entry => ({ role: entry.role, content: entry.content })).slice(-ROUTED_CONTEXT_MESSAGE_LIMIT);
    let content: string;
    let assistantTimestampMs = now();
    let assistantId = `t${turn}s0`;
    let nextAssistantIndex = 1;
    let assistantStreamStarted = false;
    let sentViaSendMessage = false;
    const emitAssistant = (nextContent: string, streaming: boolean) => {
      const entry = { kind: "send-message", id: assistantId, message: { type: "text", content: nextContent }, routed: true, streaming, timestampMs: assistantTimestampMs };
      emitTranscript(agentId, assistantStreamStarted ? "updated" : "appended", entry);
      assistantStreamStarted = true;
    };
    const sendUserMessage = async (message: Record<string, unknown>): Promise<unknown> => {
      if (assistantStreamStarted) {
        assistantId = `t${turn}s${nextAssistantIndex++}`;
        assistantTimestampMs = now();
        assistantStreamStarted = false;
      }
      const messageId = assistantId;
      const timestamp = now();
      const text = typeof message.content === "string" ? message.content : "";
      await append(agentId, [{ provider, role: "assistant", content: text, id: messageId, timestampMs: timestamp }]);
      emitTranscript(agentId, "appended", { kind: "send-message", id: messageId, message: { type: "text", content: text }, routed: true, timestampMs: timestamp });
      sentViaSendMessage = true;
      assistantId = `t${turn}s${nextAssistantIndex++}`;
      assistantTimestampMs = now();
      assistantStreamStarted = false;
      return { messageId };
    };
    let bridge: Awaited<ReturnType<typeof createProviderBridge>> = null;
    let turnOutcome: "ok" | "error" = "error";
    const onTextDelta = (_delta: string, accumulated: string) => emitAssistant(accumulated, true);
    try {
      bridge = await createProviderBridge(
        provider,
        tools,
        tool => dispatchRoutedTool(provider, agentId, clientNonce, tool, tool.args, tool.toolCallId, true, sendUserMessage),
      );
      const providerOptions = bridge == null
        ? {
          tools,
          executeTool: async (definition: RoutedTool, toolArgs: unknown, toolCallId: string) => await dispatchRoutedTool(provider, agentId, clientNonce, definition, toolArgs, toolCallId, true, sendUserMessage),
          onTextDelta,
        }
        : {
          mcpServerUrl: bridge.url,
          tools,
          executeTool: async (definition: RoutedTool, toolArgs: unknown, toolCallId: string) => await dispatchRoutedTool(provider, agentId, clientNonce, definition, toolArgs, toolCallId, true, sendUserMessage),
          onTextDelta,
      };
      content = await runRoutedProviderText(provider, messages, providerOptions);
      turnOutcome = "ok";
    } finally {
      finishActivity();
      await bridge?.close();
      reportInferenceDebug({ provider, phase: "turn", agentId, durationMs: Math.round(performance.now() - turnStartedAt), outcome: turnOutcome });
    }
    if (!sentViaSendMessage || content.trim().length > 0) {
      await append(agentId, [{ provider, role: "assistant", content, id: assistantId, timestampMs: assistantTimestampMs }]);
      emitAssistant(content, false);
    }
    return { accepted: true, clientNonce, provider };
  };

  return {
    provider(): SandInferenceProvider { return settings.getInferenceProvider(); },
    decorateTranscriptEvent,
    async dispatch(method: string, args: unknown): Promise<{ handled: boolean; value?: unknown }> {
      const provider = settings.getInferenceProvider();
      if (method === "reactToMessage") {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.agentId === "string" ? record.agentId : "";
        const entryId = typeof record.entryId === "string" ? record.entryId : "";
        const emoji = typeof record.emoji === "string" ? record.emoji : "";
        const updated = await toggleLocalReaction(agentId, entryId, emoji);
        if (updated != null) {
          emitTranscript(agentId, "updated", updated);
          return { handled: true, value: undefined };
        }
      }
      if ((provider !== "cursor" || shouldUseCursorAgentCli(provider)) && ["getAgentTranscriptTail", "openAgentTail", "getAgentTranscriptWindow"].includes(method)) {
        const record = asRecord(args) ?? {};
        const agentId = typeof record.id === "string" ? record.id : "";
        const fallback = method === "getAgentTranscriptWindow" ? { entries: [], threadCounts: {} } : { entries: [] };
        const [remote, local] = await Promise.all([readBoxWithFallback(options.dispatchRemote(method, args), fallback), load()]);
        const result = asRecord(remote);
        if (result == null || !Array.isArray(result.entries) || agentId.length === 0) return { handled: true, value: remote };
        const entries = mergeRoutedTranscriptEntries(result.entries, (local.agents[agentId] ?? []).map(projectInferenceRouterTranscriptEntry));
        const limit = typeof record.limit === "number" && Number.isInteger(record.limit) && record.limit > 0 ? record.limit : 500;
        return { handled: true, value: { ...result, entries: entries.slice(-limit), ...(method === "getAgentTranscriptWindow" && !asRecord(result.threadCounts) ? { threadCounts: {} } : {}) } };
      }
      if (method !== "sendPrompt" || provider === "cursor" && !shouldUseCursorAgentCli(provider)) return { handled: false };
      const record = asRecord(args) ?? {};
      const agentId = typeof record.agentId === "string" ? record.agentId : "";
      const previous = queues.get(agentId) ?? Promise.resolve();
      const next = previous.catch(() => undefined).then(() => execute(provider, record)).catch(async (error) => {
        const timestampMs = now();
        const content = `Router error: ${error instanceof Error ? error.message : String(error)}`;
        if (agentId.length > 0) {
          const id = `router-error-${Date.now()}-${randomUUID()}`;
          await append(agentId, [{ provider, role: "assistant", content, id, timestampMs }]);
          emitTranscript(agentId, "appended", { kind: "send-message", id, message: { type: "text", content }, routed: true, timestampMs });
        }
      });
      const queued = next.finally(() => { if (queues.get(agentId) === queued) queues.delete(agentId); });
      queues.set(agentId, queued);
      void queued;
      return { handled: true, value: { accepted: true, clientNonce: record.clientNonce, provider } };
    },
  };
}
