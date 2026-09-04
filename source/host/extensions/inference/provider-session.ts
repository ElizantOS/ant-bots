import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { query as queryClaude, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool, type CoreMessage, type LanguageModelV1, type ToolSet } from "ai";

import { BasePromptBuilder, BasePromptExecutor } from "../../../packages/chat-inference/base.js";
import type { SandInferenceProvider } from "../../../shared/inference-router.js";
import { getLocalInferenceCliStatus, resolveClaudeCodeCliPath, resolveCodexCliPath, resolveCursorAgentCliPath, resolveOpenCodeCliPath } from "../../../shared/node/inference-router-local.js";
import { getSandRootDir } from "../../host-paths.js";
import { DEFAULT_SAND_SYSTEM_PROMPT } from "../../runner/system-prompt.js";
import { reportInferenceDebug } from "../../../shared/inference-diagnostics.js";
import { SandSettingsStore } from "../../../shared/node/settings/sand-settings-store.js";
import { getBoxSecretsStorePath } from "../secrets/secrets-service.js";
import { streamCodexDirectResponses, type CodexDirectTool } from "./codex-direct-responses.js";
import type { LabelMessage, PromptExecutor } from "./sand-labeling.js";

type Loose = Record<string, any>;
interface ProviderMessage extends LabelMessage { role: string; content: string | readonly unknown[] }
type RoutedProvider = SandInferenceProvider;
type UsageRecord = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
type RoutedToolExecutor = (tool: Loose, args: unknown, toolCallId: string) => Promise<unknown>;

// The canonical prompt starts with "You are Grok Bot, a warm, concise desktop assistant.".
// Its agent-tool rule remains: never claim an agent was created, updated, or messaged unless the corresponding tool returned success.

function recordRoutedUsage(provider: SandInferenceProvider, usage: UsageRecord): void {
  new SandSettingsStore(join(getSandRootDir(), "settings.json")).recordInferenceUsage(provider, usage);
}

function persistedSecrets(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(getBoxSecretsStorePath(), "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};
    const secrets = (parsed as { secrets?: unknown }).secrets;
    if (typeof secrets !== "object" || secrets == null || Array.isArray(secrets)) return {};
    return Object.fromEntries(Object.entries(secrets).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}

function openRouterCredential(): string {
  const value = process.env.OPENROUTER_API_KEY?.trim() || persistedSecrets().OPENROUTER_API_KEY?.trim();
  if (value == null || value.length === 0) throw new Error("OpenRouter needs OPENROUTER_API_KEY. Add it in Settings → Router.");
  return value;
}

export function isRoutedProviderReady(provider: RoutedProvider): boolean {
  try {
    if (provider === "cursor") return getLocalInferenceCliStatus().cursor.authenticated;
    if (provider === "openrouter") {
      openRouterCredential();
      return true;
    }
    if (provider === "codex") {
      const transport = configuredCodexTransport();
      if (transport.useChatGptAccount) codexCredentials();
      else if (transport.authorization == null) throw new Error("Configured Codex provider has no bearer token.");
      return true;
    }
    if (provider === "opencode") return getLocalInferenceCliStatus().opencode.authenticated;
    return getLocalInferenceCliStatus()["claude-code"].authenticated;
  } catch {
    return false;
  }
}

function storedInferenceModel(provider: SandInferenceProvider): string | undefined {
  try { return new SandSettingsStore(join(getSandRootDir(), "settings.json")).getInferenceModel(provider); }
  catch { return undefined; }
}

function promptContentText(content: string | readonly unknown[]): string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (typeof part === "object" && part != null && !Array.isArray(part) && typeof (part as { text?: unknown }).text === "string") return (part as { text: string }).text;
    try { return JSON.stringify(part) ?? String(part); }
    catch { return String(part); }
  }).join("\n");
}

function providerConversationText(messages: readonly ProviderMessage[]): string {
  return messages.map((message) => `${message.role.toUpperCase()}: ${promptContentText(message.content)}`).join("\n\n");
}

export interface RoutedProviderPrompt {
  readonly systemPrompt: string;
  readonly conversationMessages: readonly { readonly role: string; readonly content: string | readonly unknown[] }[];
  readonly conversationText: string;
  readonly cliPrompt: string;
}

export function composeRoutedProviderPrompt(
  messages: readonly { readonly role: string; readonly content: string | readonly unknown[] }[],
  systemPromptAddition?: string,
): RoutedProviderPrompt {
  const systemMessages = messages
    .filter((message) => message.role === "system")
    .map((message) => promptContentText(message.content).trim())
    .filter((content) => content.length > 0);
  const conversationMessages = messages.filter((message) => message.role !== "system");
  const baseSystem = systemMessages.length > 0 ? systemMessages.join("\n\n") : DEFAULT_SAND_SYSTEM_PROMPT;
  const additions = [systemPromptAddition?.trim() ?? ""].filter((value) => value.length > 0);
  const systemPrompt = [baseSystem, ...additions].join("\n\n");
  const conversationText = providerConversationText(conversationMessages as readonly ProviderMessage[]);
  return {
    systemPrompt,
    conversationMessages,
    conversationText,
    cliPrompt: `${systemPrompt}\n\nContinue this Grok Bot conversation.\n\n${conversationText}`,
  };
}

function renderRoutedProviderCliPrompt(prompt: RoutedProviderPrompt): string {
  return prompt.cliPrompt;
}

function codexInputMessages(messages: readonly { readonly role: string; readonly content: string | readonly unknown[] }[]): readonly Loose[] {
  return messages.map((message) => {
    const content = promptContentText(message.content);
    if (message.role === "assistant" || message.role === "user") return { role: message.role, content };
    return { role: "user", content: `${message.role.toUpperCase()}: ${content}` };
  });
}

function deferred<T>() {
  const result = Promise.withResolvers<T>();
  result.promise.catch(() => {});
  return result;
}

function response(text: string, id: string, modelId: string, toolCalls: readonly { readonly toolCallId: string; readonly toolName: string; readonly args: unknown }[] = []) {
  const content = [
    ...(text.length === 0 ? [] : [{ type: "text", text }]),
    ...toolCalls.map((call) => ({ type: "tool-call", toolCallId: call.toolCallId, toolName: call.toolName, args: call.args })),
  ];
  return { id, modelId, timestamp: new Date(), headers: {}, messages: [{ role: "assistant", content: content.length === 0 ? "" : content }] };
}

type CodexCredentials = { accessToken: string; refreshToken: string; idToken: string; accountId: string; path: string; document: Loose };
type CodexTransport = { endpoint: string; authorization?: string; useChatGptAccount: boolean };
type CodexMcpMode = "direct" | "cli";

const CODEX_MCP_MODE_ENV = "SAND_CODEX_MCP_MODE";
const DEFAULT_CODEX_MCP_MODE: CodexMcpMode = "direct";

function configuredCodexMcpMode(env: NodeJS.ProcessEnv = process.env): CodexMcpMode {
  return env[CODEX_MCP_MODE_ENV]?.trim().toLowerCase() === "cli" ? "cli" : DEFAULT_CODEX_MCP_MODE;
}

function readQuotedConfigValue(config: string, sectionName: string | null, key: string): string | undefined {
  let section: string | null = null;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const valuePattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*["']([^"']+)["']\\s*$`);
  for (const line of config.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header != null) {
      section = header[1] ?? null;
      continue;
    }
    if (section !== sectionName) continue;
    const match = valuePattern.exec(line);
    if (match != null) return match[1];
  }
  return sectionName == null ? valuePattern.exec(config)?.[1] : undefined;
}

function configuredCodexTransport(): CodexTransport {
  const fallback: CodexTransport = {
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    useChatGptAccount: true,
  };
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    const provider = readQuotedConfigValue(config, null, "model_provider");
    if (provider == null || provider.length === 0) return fallback;
    const section = `model_providers.${provider}`;
    const baseUrl = readQuotedConfigValue(config, section, "base_url")?.trim();
    if (baseUrl == null || baseUrl.length === 0) return fallback;
    const bearer = readQuotedConfigValue(config, section, "experimental_bearer_token")?.trim();
    return {
      endpoint: `${baseUrl.replace(/\/+$/, "")}/responses`,
      ...(bearer == null || bearer.length === 0 ? {} : { authorization: `Bearer ${bearer}` }),
      useChatGptAccount: bearer == null || bearer.length === 0,
    };
  } catch {
    return fallback;
  }
}

function codexCredentials(): CodexCredentials {
  const path = join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "auth.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Codex login credentials must be a private direct regular file.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Loose;
  const accessToken = parsed?.tokens?.access_token;
  const refreshToken = parsed?.tokens?.refresh_token;
  const idToken = parsed?.tokens?.id_token;
  const accountId = parsed?.tokens?.account_id;
  if (parsed?.auth_mode !== "chatgpt" || typeof accessToken !== "string" || accessToken.length === 0 || typeof refreshToken !== "string" || refreshToken.length === 0 || typeof idToken !== "string" || idToken.length === 0 || typeof accountId !== "string" || accountId.length === 0) {
    throw new Error("Codex is not signed in with ChatGPT. Run `codex login`, then reopen Grok Bot.");
  }
  return { accessToken, refreshToken, idToken, accountId, path, document: parsed };
}

function jwtAudience(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Loose;
    const audience = payload.aud;
    return typeof audience === "string" ? audience : Array.isArray(audience) ? audience.find((value): value is string => typeof value === "string") ?? null : null;
  } catch { return null; }
}

async function refreshCodexCredentials(current: CodexCredentials): Promise<CodexCredentials> {
  const clientId = jwtAudience(current.idToken);
  if (clientId == null) throw new Error("Codex login expired and its refresh identity is invalid. Run `codex login` again.");
  const refresh = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId }),
  });
  if (!refresh.ok) throw new Error("Codex login expired and could not be refreshed. Run `codex login` again.");
  const payload = await refresh.json() as Loose;
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) throw new Error("Codex returned an invalid refreshed login. Run `codex login` again.");
  const document = {
    ...current.document,
    tokens: {
      ...current.document.tokens,
      access_token: payload.access_token,
      refresh_token: typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : current.refreshToken,
      id_token: typeof payload.id_token === "string" && payload.id_token.length > 0 ? payload.id_token : current.idToken,
    },
    last_refresh: new Date().toISOString(),
  };
  const temporary = `${current.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temporary, current.path);
  return codexCredentials();
}

function codexAuthenticatedFetch(initial: CodexCredentials): typeof fetch {
  let credentials = initial;
  return async (input, init) => {
    const perform = () => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.set("ChatGPT-Account-Id", credentials.accountId);
      return fetch(input, { ...init, headers });
    };
    let result = await perform();
    if (result.status !== 401) return result;
    credentials = await refreshCodexCredentials(credentials);
    result = await perform();
    return result;
  };
}

type CodexCliRunResult = {
  readonly text: string;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  };
};

const DEFAULT_CODEX_MCP_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_REASONING_EFFORT = "medium" as const;
const DEFAULT_CLAUDE_TIMEOUT_MS = 60_000;
const DEFAULT_CLAUDE_MAX_RETRIES = 2;

function configuredCodexMcpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SAND_CODEX_MCP_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 600_000
    ? Math.floor(parsed)
    : DEFAULT_CODEX_MCP_TIMEOUT_MS;
}

function configuredClaudeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SAND_CLAUDE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 600_000
    ? Math.floor(parsed)
    : DEFAULT_CLAUDE_TIMEOUT_MS;
}

function configuredClaudeMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SAND_CLAUDE_MAX_RETRIES);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 10 ? parsed : DEFAULT_CLAUDE_MAX_RETRIES;
}

function claudeProcessEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const configured = env.CLAUDE_CODE_MAX_RETRIES?.trim();
  return configured == null || configured.length === 0
    ? { ...env, CLAUDE_CODE_MAX_RETRIES: String(configuredClaudeMaxRetries(env)) }
    : { ...env };
}

const CLAUDE_ROUTED_TOOL_PREFIX = "mcp__grok_bot_plugins__";
const CLAUDE_ROUTED_SEND_MESSAGE_NAME = `${CLAUDE_ROUTED_TOOL_PREFIX}SendMessage`;

/**
 * Claude's original prompt requires SendMessage to be the visible voice. In
 * SDK mode Claude can otherwise re-send the same visible result forever after
 * the real work is complete. Bound the visible part of a routed turn while
 * still allowing the normal acknowledgement -> work -> result shape.
 */
export function createClaudeRoutedToolGate(options: {
  readonly onLimit?: () => void;
  readonly onVisibleMessageComplete?: () => void;
} = {}) {
  let sendMessageCount = 0;
  let nonSendMessageToolCount = 0;
  let firstSendNeedsContinuation = false;
  let limitReached = false;
  let visibleMessageComplete = false;
  return {
    permission(toolName: string, input: Record<string, unknown>) {
      if (!toolName.startsWith("mcp__grok_bot_plugins__")) {
        return { behavior: "deny" as const, message: "Only Grok Bot tools are available in this routed session.", interrupt: true };
      }
      if (toolName === CLAUDE_ROUTED_SEND_MESSAGE_NAME) {
        if (sendMessageCount === 0) {
          const content = typeof input.content === "string" ? input.content.trim() : "";
          // A first message that says what work is about to happen is an
          // acknowledgement. Short/final text ("OK", "done", etc.) closes a
          // conversational turn by itself, even if Claude probes another tool.
          firstSendNeedsContinuation = nonSendMessageToolCount === 0
            && content.length >= 6
            && /(?:先|正在|查询|调用|获取|检查|处理|开始|稍后|我会|我来|让我)/u.test(content);
        }
        const maxVisibleMessages = firstSendNeedsContinuation && nonSendMessageToolCount > 0 ? 2 : 1;
        if (sendMessageCount >= maxVisibleMessages) {
          limitReached = true;
          options.onLimit?.();
          return {
            behavior: "deny" as const,
            message: "The user-facing message for this step was already delivered. Stop this turn now; do not call SendMessage again.",
            interrupt: true,
          };
        }
        sendMessageCount += 1;
        visibleMessageComplete = !firstSendNeedsContinuation
          || nonSendMessageToolCount > 0 && sendMessageCount >= 2;
        if (visibleMessageComplete) options.onVisibleMessageComplete?.();
      } else {
        nonSendMessageToolCount += 1;
      }
      return { behavior: "allow" as const, updatedInput: input };
    },
    didReachLimit: () => limitReached,
    didCompleteVisibleMessage: () => visibleMessageComplete,
  };
}

function lastNonEmptyLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const line = lines.at(-1);
  return line == null ? undefined : line.slice(-500);
}

/** Turn Claude's stream result into a useful user-facing error. */
export function formatClaudeProviderFailure(input: {
  readonly final?: unknown | undefined;
  readonly processError?: unknown | undefined;
  readonly apiErrorStatus?: number | undefined;
  readonly retryAttempt?: number | undefined;
  readonly retryMax?: number | undefined;
  readonly stderr?: string | undefined;
  readonly timedOut?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}): string {
  const final = input.final != null && typeof input.final === "object" && !Array.isArray(input.final)
    ? input.final as Loose
    : undefined;
  const result = typeof final?.result === "string" ? final.result.trim() : "";
  const errors = Array.isArray(final?.errors)
    ? final.errors.filter((value: unknown): value is string => typeof value === "string" && value.trim().length > 0).join("\n").trim()
    : "";
  const finalIsError = final?.is_error === true || final?.subtype != null && final.subtype !== "success";
  if (finalIsError && (result.length > 0 || errors.length > 0)) {
    const detail = result.length > 0 ? result : errors;
    const status = typeof input.apiErrorStatus === "number" && Number.isFinite(input.apiErrorStatus) ? input.apiErrorStatus : undefined;
    const statusSuffix = status != null && !detail.includes(String(status)) ? ` (HTTP ${status})` : "";
    const retrySuffix = input.retryAttempt != null && input.retryAttempt > 0
      ? ` (after ${input.retryAttempt + 1} attempts)`
      : "";
    return `Claude Code: ${detail}${statusSuffix}${retrySuffix}`;
  }
  if (input.timedOut === true) {
    const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) ? input.timeoutMs : DEFAULT_CLAUDE_TIMEOUT_MS;
    return `Claude Code timed out after ${Math.round(timeoutMs / 1_000)} seconds while waiting for a response.`;
  }
  const processMessage = input.processError instanceof Error ? input.processError.message.trim() : typeof input.processError === "string" ? input.processError.trim() : "";
  const retryDetail = input.retryAttempt != null
    ? ` (last API retry ${input.retryAttempt}/${input.retryMax ?? "?"}${input.apiErrorStatus == null ? "" : `, HTTP ${input.apiErrorStatus}`})`
    : "";
  const stderr = lastNonEmptyLine(input.stderr);
  if (processMessage.length > 0) return `${processMessage}${retryDetail}${stderr == null || processMessage.includes(stderr) ? "" : `: ${stderr}`}`;
  if (stderr != null) return stderr;
  return "Claude Code failed without a diagnostic.";
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexMcpConfig(transport: CodexTransport, model: string, mcpServerUrl: string, reasoningEffort: "minimal" | "low" | "medium" | "high" | "xhigh"): string {
  const authorization = transport.authorization;
  if (transport.useChatGptAccount) {
    return [
      `model = ${tomlString(model)}`,
      `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
      "disable_response_storage = true",
      "network_access = \"enabled\"",
      "",
      "[features]",
      "shell_tool = false",
      "",
      "[mcp_servers.grok_bot]",
      `url = ${tomlString(mcpServerUrl)}`,
      "",
    ].join("\n");
  }
  if (authorization == null || !authorization.startsWith("Bearer ") || authorization.slice("Bearer ".length).trim().length === 0) {
    throw new Error("Codex MCP mode requires a configured bearer token.");
  }
  const lines = [
    "model_provider = \"grok-router\"",
    `model = ${tomlString(model)}`,
    `model_reasoning_effort = ${tomlString(reasoningEffort)}`,
    "disable_response_storage = true",
    "network_access = \"enabled\"",
    "",
    "[features]",
    "shell_tool = false",
    "",
    "[model_providers.grok-router]",
    "name = \"grok-router\"",
    `base_url = ${tomlString(transport.endpoint.replace(/\/responses\/?$/, ""))}`,
    "wire_api = \"responses\"",
    "requires_openai_auth = true",
    `experimental_bearer_token = ${tomlString(authorization.slice("Bearer ".length).trim())}`,
    "",
    "[mcp_servers.grok_bot]",
    `url = ${tomlString(mcpServerUrl)}`,
    "",
  ];
  return lines.join("\n");
}

function codexCliUsage(value: Record<string, any> | undefined): CodexCliRunResult["usage"] {
  return {
    inputTokens: typeof value?.input_tokens === "number" && Number.isFinite(value.input_tokens) ? value.input_tokens : 0,
    outputTokens: typeof value?.output_tokens === "number" && Number.isFinite(value.output_tokens) ? value.output_tokens : 0,
    cacheReadTokens: typeof value?.cached_input_tokens === "number" && Number.isFinite(value.cached_input_tokens) ? value.cached_input_tokens : 0,
    cacheWriteTokens: 0,
  };
}

async function runCodexCli(options: {
  readonly transport: CodexTransport;
  readonly model: string;
  readonly prompt: string;
  readonly mcpServerUrl: string;
  readonly timeoutMs?: number;
}): Promise<CodexCliRunResult> {
  const executable = resolveCodexCliPath();
  if (executable == null) throw new Error("Codex CLI is not installed. Install Codex CLI and reopen Grok Bot.");
  const temporaryHome = await mkdtemp(join(tmpdir(), "grok-bot-codex-mcp-"));
  const outputPath = join(temporaryHome, "last-message.txt");
  try {
    if (options.transport.useChatGptAccount) {
      const credentials = codexCredentials();
      await writeFile(join(temporaryHome, "auth.json"), `${JSON.stringify(credentials.document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    await writeFile(join(temporaryHome, "config.toml"), codexMcpConfig(options.transport, options.model, options.mcpServerUrl, configuredCodexReasoningEffort()), { encoding: "utf8", mode: 0o600 });
    const result = await new Promise<{ readonly code: number | null; readonly completed: boolean; readonly text: string; readonly usage: CodexCliRunResult["usage"] }>((resolve, reject) => {
      const child = spawn(executable, ["exec", "--json", "--ephemeral", "--skip-git-repo-check", "--approve-for-me", "--cd", temporaryHome, "--output-last-message", outputPath, "--model", options.model, "-"], {
        cwd: temporaryHome,
        env: { ...process.env, CODEX_HOME: temporaryHome },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let text = "";
      let usage: CodexCliRunResult["usage"] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      let completed = false;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let completionGrace: ReturnType<typeof setTimeout> | undefined;
      let forceCompletion: ReturnType<typeof setTimeout> | undefined;
      const terminateChild = (): void => {
        if (child.exitCode != null || child.signalCode != null) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
        }, 2_000).unref?.();
      };
      const finish = (error?: Error, code: number | null = null) => {
        if (settled) return;
        settled = true;
        if (timeout != null) clearTimeout(timeout);
        if (completionGrace != null) clearTimeout(completionGrace);
        if (forceCompletion != null) clearTimeout(forceCompletion);
        if (error != null) reject(error);
        else resolve({ code, completed, text, usage });
      };
      const parseOutput = (line: string): void => {
        let event: Record<string, any>;
        try { event = JSON.parse(line) as Record<string, any>; } catch { return; }
        const item = typeof event.item === "object" && event.item != null ? event.item as Record<string, any> : undefined;
        if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") text = item.text;
        if (event.type === "turn.completed") {
          completed = true;
          usage = codexCliUsage(typeof event.usage === "object" && event.usage != null ? event.usage as Record<string, any> : undefined);
          completionGrace ??= setTimeout(() => {
            if (settled) return;
            terminateChild();
            forceCompletion ??= setTimeout(() => finish(undefined, 0), 2_000);
          }, 500);
        }
        if (event.type === "error") {
          terminateChild();
          finish(new Error(`Codex CLI reported an execution error: ${JSON.stringify(event.error ?? event)}`));
        }
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += String(chunk);
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) parseOutput(line.trim());
      });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
      child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      child.once("close", (code) => {
        if (stdout.trim().length > 0) parseOutput(stdout.trim());
        if (!completed && code !== 0) finish(new Error(`Codex CLI exited before completing the turn (${code == null ? "signal" : code}): ${stderr.trim() || "no stderr"}`), code);
        else if (!completed) finish(new Error(`Codex CLI ended without completing the turn: ${stderr.trim() || "no stderr"}`), code);
        else finish(undefined, code);
      });
      timeout = setTimeout(() => {
        terminateChild();
        finish(new Error("Codex MCP turn timed out."));
      }, options.timeoutMs ?? configuredCodexMcpTimeoutMs());
      child.stdin.on("error", () => {});
      child.stdin.end(options.prompt);
    });
    let text = result.text;
    try {
      const lastMessage = (await readFile(outputPath, "utf8")).trim();
      if (lastMessage.length > 0) text = lastMessage;
    } catch {}
    if (text.trim().length === 0) throw new Error("Codex CLI completed without a text response.");
    return { text, usage: result.usage };
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
}

function codexCliExecutor(
  prompt: RoutedProviderPrompt,
  invocationId: string,
  mcpServerUrl: string,
  definitions?: readonly Loose[],
  executeTool?: RoutedToolExecutor,
  onUsage?: (usage: UsageRecord) => void,
) {
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const fullStream = (async function* () {
    try {
      const result = await runCodexCli({
        transport: configuredCodexTransport(),
        model,
        prompt: renderRoutedProviderCliPrompt(prompt),
        mcpServerUrl,
      });
      if (result.text.length > 0) yield { type: "text-delta" as const, textDelta: result.text };
      onUsage?.(result.usage);
      usage.resolve({ promptTokens: result.usage.inputTokens, completionTokens: result.usage.outputTokens, totalTokens: result.usage.inputTokens + result.usage.outputTokens });
      extendedUsage.resolve({ ...result.usage, maxTokens: 0 });
      metadata.resolve({ openai: { direct: true, cli: true } });
      resultResponse.resolve(response(result.text, invocationId, model));
    } catch (error) {
      if (error instanceof Error && error.message === "Codex MCP turn timed out.") {
        // A stuck MCP child should not strand the turn when the same endpoint
        // can answer the request through the direct Responses tool protocol.
        const fallback = codexDirectExecutor(prompt, invocationId, definitions, executeTool, onUsage);
        try {
          for await (const event of fallback.fullStream) yield event;
          usage.resolve(await fallback.usage);
          extendedUsage.resolve(await fallback.extendedUsage);
          metadata.resolve(await fallback.providerMetadata);
          resultResponse.resolve(await fallback.response);
          return;
        } catch (fallbackError) {
          error = fallbackError;
        }
      }
      usage.reject(error);
      extendedUsage.reject(error);
      metadata.reject(error);
      resultResponse.reject(error);
      throw error;
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function configuredCodexModel(): string {
  const selected = process.env.SAND_CODEX_MODEL?.trim();
  if (selected) return selected;
  const stored = storedInferenceModel("codex");
  if (stored != null) return stored;
  try {
    const config = readFileSync(join(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"), "config.toml"), "utf8");
    return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(config)?.[1]?.trim() || "gpt-5.4";
  } catch { return "gpt-5.4"; }
}

function configuredCodexReasoningEffort(): "minimal" | "low" | "medium" | "high" | "xhigh" {
  const selected = process.env.SAND_CODEX_REASONING_EFFORT?.trim();
  if (selected === "minimal" || selected === "low" || selected === "medium" || selected === "high" || selected === "xhigh") return selected;
  // Grok Bot has a separate latency budget from the interactive Codex CLI.
  // In particular, do not inherit a user's xhigh CLI setting by accident.
  return DEFAULT_CODEX_REASONING_EFFORT;
}

function codexTools(definitions: readonly Loose[] | undefined): CodexDirectTool[] | undefined {
  if (definitions == null) return undefined;
  const tools = definitions.flatMap((source): CodexDirectTool[] => {
    const parameters = source.inputSchema ?? source.parameters;
    return typeof source.name === "string" && source.name.length > 0 && parameters != null ? [{
      name: source.name,
      ...(typeof source.description === "string" ? { description: source.description } : {}),
      parameters,
      source,
    }] : [];
  });
  return tools.length === 0 ? undefined : tools;
}

function codexDirectExecutor(prompt: RoutedProviderPrompt, invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const transport = configuredCodexTransport();
  const credentials = transport.useChatGptAccount ? codexCredentials() : undefined;
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCodexModel();
  const tools = codexTools(definitions);
  const reasoningEffort = configuredCodexReasoningEffort();
  const fullStream = (async function* () {
    let text = "";
    try {
      for await (const event of streamCodexDirectResponses({
        fetch: credentials == null ? fetch : codexAuthenticatedFetch(credentials),
        endpoint: transport.endpoint,
        ...(transport.authorization == null ? {} : { authorization: transport.authorization }),
        ...(credentials == null ? {} : { accountId: credentials.accountId }),
        model,
        reasoningEffort,
        instructions: prompt.systemPrompt,
        input: codexInputMessages(prompt.conversationMessages),
        ...(tools == null ? {} : { tools }),
        ...(executeTool == null ? {} : { executeTool: async (selected, args, toolCallId) => await executeTool(selected.source, args, toolCallId) }),
        maxSteps: tools == null ? 1 : 8,
      })) {
        if (event.type === "text-delta") { text += event.delta; yield { type: "text-delta" as const, textDelta: event.delta }; continue; }
        if (event.type === "tool-call-streaming-start") { yield event; continue; }
        if (event.type === "tool-call-delta") { yield event; continue; }
        if (event.type === "tool-call") { yield event; continue; }
        const basic = { promptTokens: event.usage.inputTokens, completionTokens: event.usage.outputTokens, totalTokens: event.usage.inputTokens + event.usage.outputTokens };
        const extended = { ...event.usage, maxTokens: 0 };
        onUsage?.(event.usage);
        usage.resolve(basic);
        extendedUsage.resolve(extended);
        metadata.resolve({ openai: { responseId: event.responseId, direct: true } });
        resultResponse.resolve(response(text, invocationId, model, event.toolCalls));
      }
    } catch (error) { usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error; }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function codexExecutor(prompt: RoutedProviderPrompt, invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string) {
  // Direct Responses avoids a fresh CLI process and MCP handshake for every
  // turn. Keep the CLI path available for explicit compatibility testing.
  if (mcpServerUrl != null && configuredCodexMcpMode() === "cli" && resolveCodexCliPath() != null) {
    return codexCliExecutor(prompt, invocationId, mcpServerUrl, definitions, executeTool, onUsage);
  }
  return codexDirectExecutor(prompt, invocationId, definitions, executeTool, onUsage);
}

type CursorAgentToolExecutor = (toolName: string, args: unknown, toolCallId: string) => Promise<unknown>;
type CursorAgentRunResult = {
  readonly text: string;
  readonly usage: UsageRecord;
  readonly sessionId?: string;
};

function cursorAgentMcpText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }
}

function cursorAgentMcpResult(value: unknown): Record<string, unknown> {
  const root = typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, any> : null;
  const nested = root?.result;
  if (typeof nested === "object" && nested != null && !Array.isArray(nested) && nested.case === "success") {
    const success = nested.value as Record<string, any> | undefined;
    const content = Array.isArray(success?.content)
      ? success.content.flatMap((item: unknown) => {
        const row = typeof item === "object" && item != null && !Array.isArray(item) ? item as Record<string, any> : null;
        const carrier = row?.content;
        const payload = typeof carrier === "object" && carrier != null && !Array.isArray(carrier) ? carrier.value : undefined;
        return carrier?.case === "text" && typeof payload?.text === "string" ? [{ type: "text", text: payload.text }] : [];
      })
      : [];
    return { isError: success?.isError === true, content: content.length > 0 ? content : [{ type: "text", text: cursorAgentMcpText(success ?? value) }] };
  }
  if (root?.role === "tool" && Array.isArray(root.content)) {
    const content = root.content.flatMap((item: unknown) => {
      const row = typeof item === "object" && item != null && !Array.isArray(item) ? item as Record<string, any> : null;
      return row?.type === "tool-result" ? [{ type: "text", text: typeof row.result === "string" ? row.result : cursorAgentMcpText(row.result) }] : [];
    });
    return { isError: false, content: content.length > 0 ? content : [{ type: "text", text: cursorAgentMcpText(value) }] };
  }
  return { isError: false, content: [{ type: "text", text: cursorAgentMcpText(value) }] };
}

async function createCursorAgentMcpBridge(
  definitions: readonly Loose[],
  executeTool: CursorAgentToolExecutor,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const tools = new Map<string, Loose>();
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.trim().length === 0) continue;
    tools.set(definition.name, definition);
  }
  if (tools.size === 0) throw new Error("Cursor Agent CLI requires at least one executable tool definition.");
  const secret = crypto.randomUUID();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== `/mcp/${secret}`) { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 1_048_576) { response.writeHead(413).end(); return; }
    }
    let message: Record<string, any>;
    try { message = JSON.parse(body) as Record<string, any>; }
    catch { response.writeHead(400).end(); return; }
    if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    const reply = (result: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    };
    try {
      if (message.method === "initialize") {
        reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "grok-bot-tools", version: "1" } });
        return;
      }
      if (message.method === "tools/list") {
        reply({ tools: [...tools.values()].map((definition) => ({
          name: definition.name,
          description: typeof definition.description === "string" ? definition.description : "Grok Bot tool",
          inputSchema: definition.inputSchema ?? definition.parameters ?? { type: "object", additionalProperties: true },
        })) });
        return;
      }
      if (message.method === "tools/call") {
        const params = typeof message.params === "object" && message.params != null ? message.params as Record<string, any> : {};
        const name = typeof params.name === "string" ? params.name : "";
        const definition = tools.get(name);
        if (definition == null) { reply({ isError: true, content: [{ type: "text", text: `Unknown Grok Bot tool: ${name}` }] }); return; }
        const result = await executeTool(name, params.arguments ?? {}, crypto.randomUUID());
        reply(cursorAgentMcpResult(result));
        return;
      }
      reply({});
    } catch (error) {
      reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Could not bind the Cursor Agent MCP bridge.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp/${secret}`,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error == null ? resolve() : reject(error)); }),
  };
}

function configuredCursorAgentModel(): string | undefined {
  const selected = process.env.SAND_CURSOR_AGENT_MODEL?.trim() || process.env.SAND_CURSOR_MODEL?.trim();
  if (selected != null && selected.length > 0) return selected;
  return storedInferenceModel("cursor");
}

function configuredCursorAgentTimeoutMs(): number {
  const parsed = Number(process.env.SAND_CURSOR_AGENT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 600_000 ? Math.floor(parsed) : 60_000;
}

async function runCursorAgentCli(options: {
  readonly prompt: string;
  readonly model?: string;
  readonly mcpServerUrl?: string;
}): Promise<CursorAgentRunResult> {
  const executable = resolveCursorAgentCliPath();
  if (executable == null) throw new Error("Cursor Agent CLI is not installed. Install it and run `cursor-agent login`.");
  const workspace = await mkdtemp(join(tmpdir(), "grok-bot-cursor-agent-"));
  let output = "";
  let stderr = "";
  let completed: Record<string, any> | undefined;
  let sessionId: string | undefined;
  try {
    if (options.mcpServerUrl != null) {
      await mkdir(join(workspace, ".cursor"), { recursive: true });
      await writeFile(join(workspace, ".cursor", "mcp.json"), `${JSON.stringify({ mcpServers: { grok_bot: { url: options.mcpServerUrl } } }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    }
    const args = ["--print", "--output-format", "stream-json", "--mode", "ask", "--approve-mcps", "--trust", "--disable-indexing", "--disable-codebase-ref", "--single-turn", "--workspace", workspace, ...(options.model == null ? [] : ["--model", options.model])];
    const result = await new Promise<CursorAgentRunResult>((resolve, reject) => {
      const child = spawn(executable, args, { cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const usage: UsageRecord = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const finish = (error?: Error, code?: number | null): void => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        if (error != null) { reject(error); return; }
        if (completed?.subtype !== "success") { reject(new Error(`Cursor Agent CLI ended without a successful result (${code == null ? "signal" : code}): ${stderr.trim() || "no stderr"}`)); return; }
        const text = typeof completed.result === "string" ? completed.result.trim() : "";
        if (text.length === 0) { reject(new Error("Cursor Agent CLI completed without a text response.")); return; }
        const rawUsage = completed.usage as Record<string, any> | undefined;
        resolve({ text, ...(sessionId == null ? {} : { sessionId }), usage: {
          inputTokens: typeof rawUsage?.inputTokens === "number" ? rawUsage.inputTokens : 0,
          outputTokens: typeof rawUsage?.outputTokens === "number" ? rawUsage.outputTokens : 0,
          cacheReadTokens: typeof rawUsage?.cacheReadTokens === "number" ? rawUsage.cacheReadTokens : 0,
          cacheWriteTokens: typeof rawUsage?.cacheWriteTokens === "number" ? rawUsage.cacheWriteTokens : 0,
        } });
      };
      const parseLine = (line: string): void => {
        let event: Record<string, any>;
        try { event = JSON.parse(line) as Record<string, any>; } catch { return; }
        if (event.type === "system" && typeof event.session_id === "string") sessionId = event.session_id;
        if (event.type === "result") completed = event;
        if (event.type === "error") { child.kill("SIGTERM"); finish(new Error(`Cursor Agent CLI reported an execution error: ${JSON.stringify(event.error ?? event)}`)); }
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) parseLine(line.trim());
      });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
      child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      child.once("close", (code) => { if (buffer.trim().length > 0) parseLine(buffer.trim()); finish(undefined, code); });
      timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => { if (child.exitCode == null) child.kill("SIGKILL"); }, 2_000).unref?.(); finish(new Error("Cursor Agent CLI turn timed out.")); }, configuredCursorAgentTimeoutMs());
      child.stdin.on("error", () => {});
      child.stdin.end(options.prompt);
    });
    return result;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function cursorAgentExecutor(prompt: RoutedProviderPrompt, invocationId: string, definitions: readonly Loose[] | undefined, mcpServerUrl?: string, executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredCursorAgentModel() ?? "cursor-agent";
  const fullStream = (async function* () {
    let bridge: { readonly url: string; close(): Promise<void> } | undefined;
    try {
      if (mcpServerUrl == null && definitions != null && executeTool != null) {
        bridge = await createCursorAgentMcpBridge(definitions, (toolName, args, toolCallId) => {
          const definition = definitions.find((candidate) => candidate.name === toolName) ?? { name: toolName };
          return executeTool(definition, args, toolCallId);
        });
      }
      const selectedModel = configuredCursorAgentModel();
      const selectedMcpServerUrl = mcpServerUrl ?? bridge?.url;
      const result = await runCursorAgentCli({ prompt: renderRoutedProviderCliPrompt(prompt), ...(selectedModel == null ? {} : { model: selectedModel }), ...(selectedMcpServerUrl == null ? {} : { mcpServerUrl: selectedMcpServerUrl }) });
      if (result.text.length > 0) yield { type: "text-delta" as const, textDelta: result.text };
      onUsage?.(result.usage);
      usage.resolve({ promptTokens: result.usage.inputTokens ?? 0, completionTokens: result.usage.outputTokens ?? 0, totalTokens: (result.usage.inputTokens ?? 0) + (result.usage.outputTokens ?? 0) });
      extendedUsage.resolve({ inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0, cacheReadTokens: result.usage.cacheReadTokens ?? 0, cacheWriteTokens: result.usage.cacheWriteTokens ?? 0, maxTokens: 0 });
      metadata.resolve({ cursor: { cli: true, ...(result.sessionId == null ? {} : { sessionId: result.sessionId }) } });
      resultResponse.resolve(response(result.text, invocationId, model));
    } catch (error) {
      usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error;
    } finally {
      await bridge?.close().catch(() => {});
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

type OpenCodeRunResult = {
  readonly text: string;
  readonly usage: UsageRecord;
  readonly sessionId?: string;
};

function configuredOpenCodeModel(): string {
  const selected = process.env.SAND_OPENCODE_MODEL?.trim();
  if (selected != null && selected.length > 0) return selected;
  const stored = storedInferenceModel("opencode");
  if (stored != null) return stored;
  const candidates = [
    process.env.OPENCODE_CONFIG?.trim(),
    join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "opencode", "opencode.json"),
    join(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "opencode", "opencode.jsonc"),
  ].filter((value): value is string => value != null && value.length > 0);
  for (const path of candidates) {
    try {
      const source = readFileSync(path, "utf8");
      try {
        const parsed = JSON.parse(source) as Loose;
        if (typeof parsed.model === "string" && parsed.model.trim().length > 0) return parsed.model.trim();
      } catch {
        const match = /["']model["']\s*:\s*["']([^"']+)["']/.exec(source);
        if (match?.[1]?.trim()) return match[1].trim();
      }
    } catch {}
  }
  return "opencode/big-pickle";
}

function openCodeMcpConfig(model: string, mcpServerUrl?: string): string {
  return `${JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    ...(model.length === 0 ? {} : { model }),
    ...(mcpServerUrl == null ? {} : { mcp: { grok_bot: { type: "remote", url: mcpServerUrl, enabled: true } } }),
  }, null, 2)}\n`;
}

function openCodeUsage(value: Loose | undefined): UsageRecord {
  const tokens = value?.tokens as Loose | undefined;
  const input = tokens?.input ?? value?.input_tokens ?? value?.inputTokens;
  const output = tokens?.output ?? value?.output_tokens ?? value?.outputTokens;
  const cacheRead = tokens?.cache?.read ?? value?.cache_read_input_tokens ?? value?.cacheReadTokens;
  const cacheWrite = tokens?.cache?.write ?? value?.cache_creation_input_tokens ?? value?.cacheWriteTokens;
  return {
    inputTokens: typeof input === "number" && Number.isFinite(input) ? input : 0,
    outputTokens: typeof output === "number" && Number.isFinite(output) ? output : 0,
    cacheReadTokens: typeof cacheRead === "number" && Number.isFinite(cacheRead) ? cacheRead : 0,
    cacheWriteTokens: typeof cacheWrite === "number" && Number.isFinite(cacheWrite) ? cacheWrite : 0,
  };
}

function appendOpenCodeText(event: Loose): string {
  if (event.type === "text" && typeof event.part?.text === "string") return event.part.text;
  if (event.type === "text" && typeof event.text === "string") return event.text;
  if (event.type === "message" && typeof event.message?.content === "string") return event.message.content;
  if (event.type === "result" && typeof event.result === "string") return event.result;
  return "";
}

async function runOpenCodeCli(options: { readonly prompt: string; readonly model: string; readonly mcpServerUrl?: string }): Promise<OpenCodeRunResult> {
  const executable = resolveOpenCodeCliPath();
  if (executable == null) throw new Error("OpenCode CLI is not installed. Install it and sign in with `opencode providers login`.");
  const workspace = await mkdtemp(join(tmpdir(), "grok-bot-opencode-"));
  let output = "";
  let stderr = "";
  let sessionId: string | undefined;
  let usage: UsageRecord = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  try {
    await writeFile(join(workspace, "opencode.json"), openCodeMcpConfig(options.model, options.mcpServerUrl), { encoding: "utf8", mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      // OpenCode's `run` command takes the prompt as a positional message;
      // `--prompt` is not a supported option and exits before doing any work.
      const child = spawn(executable, ["run", "--format", "json", "--auto", "--dir", workspace, "--model", options.model, options.prompt], {
        cwd: workspace,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer != null) clearTimeout(timer);
        if (error != null) reject(error); else resolve();
      };
      const parseLine = (line: string): void => {
        let event: Loose;
        try { event = JSON.parse(line) as Loose; } catch { return; }
        if (typeof event.sessionID === "string") sessionId = event.sessionID;
        if (typeof event.session_id === "string") sessionId = event.session_id;
        const text = appendOpenCodeText(event);
        if (text.length > 0) output += text;
        if (event.type === "step_finish" || event.type === "step-finish" || event.type === "result") {
          const next = openCodeUsage(event.part ?? event.usage ?? event);
          if (Object.values(next).some((value) => value !== 0)) usage = next;
        }
        if (event.type === "error") finish(new Error(`OpenCode CLI reported an execution error: ${JSON.stringify(event.error ?? event)}`));
      };
      child.stdout.on("data", (chunk: Buffer | string) => {
        buffer += String(chunk);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) parseLine(line.trim());
      });
      child.stderr.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
      child.once("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      child.once("close", (code) => {
        if (buffer.trim().length > 0) parseLine(buffer.trim());
        if (settled) return;
        if (code !== 0) finish(new Error(`OpenCode CLI exited before completing the turn (${code == null ? "signal" : code}): ${stderr.trim() || "no stderr"}`));
        else finish();
      });
      timer = setTimeout(() => {
        if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL"); }, 2_000).unref?.();
        finish(new Error("OpenCode CLI turn timed out."));
      }, configuredOpenCodeTimeoutMs());
    });
    if (output.trim().length === 0) throw new Error("OpenCode CLI completed without a text response.");
    return { text: output.trim(), usage, ...(sessionId == null ? {} : { sessionId }) };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function configuredOpenCodeTimeoutMs(): number {
  const parsed = Number(process.env.SAND_OPENCODE_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 600_000 ? Math.floor(parsed) : 120_000;
}

function openCodeExecutor(prompt: RoutedProviderPrompt, invocationId: string, definitions: readonly Loose[] | undefined, mcpServerUrl?: string, onUsage?: (usage: UsageRecord) => void) {
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const model = configuredOpenCodeModel();
  const fullStream = (async function* () {
    let bridge: { readonly url: string; close(): Promise<void> } | undefined;
    try {
      // The coordinator normally owns the bridge. Keep a direct fallback for callers
      // that use the provider session without going through the routed coordinator.
      if (mcpServerUrl == null && definitions != null && definitions.length > 0) {
        bridge = await createCursorAgentMcpBridge(definitions, async () => ({ isError: true, content: [{ type: "text", text: "OpenCode tool execution requires the coordinator bridge." }] }));
      }
      const selectedMcpServerUrl = mcpServerUrl ?? bridge?.url;
      const result = await runOpenCodeCli({ prompt: renderRoutedProviderCliPrompt(prompt), model, ...(selectedMcpServerUrl == null ? {} : { mcpServerUrl: selectedMcpServerUrl }) });
      if (result.text.length > 0) yield { type: "text-delta" as const, textDelta: result.text };
      onUsage?.(result.usage);
      const input = result.usage.inputTokens ?? 0, output = result.usage.outputTokens ?? 0;
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: result.usage.cacheReadTokens ?? 0, cacheWriteTokens: result.usage.cacheWriteTokens ?? 0, maxTokens: 0 });
      metadata.resolve({ opencode: { cli: true, model, ...(result.sessionId == null ? {} : { sessionId: result.sessionId }) } });
      resultResponse.resolve(response(result.text, invocationId, model));
    } catch (error) {
      usage.reject(error); extendedUsage.reject(error); metadata.reject(error); resultResponse.reject(error); throw error;
    } finally {
      await bridge?.close().catch(() => {});
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function claudeExecutor(prompt: RoutedProviderPrompt, invocationId: string, onUsage?: (usage: UsageRecord) => void, mcpServerUrl?: string) {
  const executable = resolveClaudeCodeCliPath();
  if (executable == null) throw new Error("Claude Code is not installed. Install and sign in to Claude Code, then reopen Grok Bot.");
  const usage = deferred<{ promptTokens: number; completionTokens: number; totalTokens: number }>();
  const extendedUsage = deferred<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; maxTokens: number }>();
  const resultResponse = deferred<ReturnType<typeof response>>();
  const metadata = deferred<Record<string, unknown>>();
  const fullStream = (async function* () {
    let final: SDKResultMessage | undefined;
    let apiErrorStatus: number | undefined;
    let retryAttempt: number | undefined;
    let retryMax: number | undefined;
    let stderr = "";
    let timedOut = false;
    const timeoutMs = configuredClaudeTimeoutMs();
    const abortController = new AbortController();
    let activeQuery: ReturnType<typeof queryClaude> | undefined;
    let finalVisibleMessagePending = false;
    let finalVisibleMessageStopTimer: ReturnType<typeof setTimeout> | undefined;
    const requestVisibleMessageStop = () => {
      finalVisibleMessagePending = true;
      // The next SDK user event is the MCP tool result. Keep a bounded fallback
      // in case a provider version does not re-emit that event.
      finalVisibleMessageStopTimer = setTimeout(() => {
        if (!finalVisibleMessagePending) return;
        void activeQuery?.interrupt().catch(() => {});
      }, 5_000);
      finalVisibleMessageStopTimer.unref?.();
    };
    const toolGate = mcpServerUrl == null
      ? undefined
      : createClaudeRoutedToolGate({
        onLimit: () => { void activeQuery?.interrupt().catch(() => {}); },
        onVisibleMessageComplete: requestVisibleMessageStop,
      });
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, timeoutMs);
    timeout.unref?.();
    try {
      const selectedModel = process.env.SAND_CLAUDE_MODEL?.trim() || storedInferenceModel("claude-code");
      activeQuery = queryClaude({ prompt: prompt.conversationText, options: {
        pathToClaudeCodeExecutable: executable,
        cwd: getSandRootDir(),
        env: claudeProcessEnvironment(),
        abortController,
        stderr: data => { stderr = `${stderr}${data}`.slice(-2_000); },
        tools: mcpServerUrl == null ? [] : ["mcp__grok_bot_plugins__*"],
        ...(mcpServerUrl == null ? {} : { mcpServers: { grok_bot_plugins: { type: "http" as const, url: mcpServerUrl } }, strictMcpConfig: true }),
        permissionMode: "default",
        maxTurns: mcpServerUrl == null ? 1 : 8,
        persistSession: false,
        systemPrompt: prompt.systemPrompt,
        // The SDK defaults to an empty setting-source list, which makes the
        // Claude CLI ignore the user's OAuth credential store. Keep user
        // settings enabled so `claude auth login` is honored by routed turns.
        settingSources: ["user" as const],
        ...(toolGate == null ? {} : { canUseTool: async (toolName: string, input: Record<string, unknown>) => toolGate.permission(toolName, input) }),
        ...(selectedModel == null || selectedModel.length === 0 ? {} : { model: selectedModel }),
      } });
      for await (const message of activeQuery) {
        const raw = message as unknown as Loose;
        if (raw.type === "system" && raw.subtype === "api_retry") {
          if (typeof raw.error_status === "number" && Number.isFinite(raw.error_status)) apiErrorStatus = raw.error_status;
          if (typeof raw.attempt === "number" && Number.isFinite(raw.attempt)) retryAttempt = raw.attempt;
          if (typeof raw.max_retries === "number" && Number.isFinite(raw.max_retries)) retryMax = raw.max_retries;
        }
        if (finalVisibleMessagePending && message.type === "user") {
          finalVisibleMessagePending = false;
          if (finalVisibleMessageStopTimer != null) clearTimeout(finalVisibleMessageStopTimer);
          void activeQuery?.interrupt().catch(() => {});
        }
        if (message.type === "result") {
          final = message;
          const status = raw.api_error_status;
          if (typeof status === "number" && Number.isFinite(status)) apiErrorStatus = status;
        }
      }
      if (toolGate?.didReachLimit() === true || toolGate?.didCompleteVisibleMessage() === true) {
        const finalUsage = (final as unknown as Loose | undefined)?.usage ?? {};
        const input = typeof finalUsage.input_tokens === "number" ? finalUsage.input_tokens : 0;
        const output = typeof finalUsage.output_tokens === "number" ? finalUsage.output_tokens : 0;
        const cacheRead = typeof finalUsage.cache_read_input_tokens === "number" ? finalUsage.cache_read_input_tokens : 0;
        const cacheWrite = typeof finalUsage.cache_creation_input_tokens === "number" ? finalUsage.cache_creation_input_tokens : 0;
        onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
        usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
        extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
        metadata.resolve({ anthropic: { ...(typeof final?.session_id === "string" ? { sessionId: final.session_id } : {}), ...(typeof final?.total_cost_usd === "number" ? { totalCostUsd: final.total_cost_usd } : {}) } });
        resultResponse.resolve(response("", invocationId, "claude-code"));
        return;
      }
      if (final == null) throw new Error("Claude Code ended without a result.");
      const failure = formatClaudeProviderFailure({ final, apiErrorStatus, retryAttempt, retryMax, stderr, timedOut, timeoutMs });
      const finalRecord = final as unknown as Loose;
      if (finalRecord.is_error === true || final.subtype !== "success") throw new Error(failure);
      const text = final.result;
      if (text.length > 0) yield { type: "text-delta" as const, textDelta: text };
      const input = final.usage.input_tokens, output = final.usage.output_tokens, cacheRead = final.usage.cache_read_input_tokens ?? 0, cacheWrite = final.usage.cache_creation_input_tokens ?? 0;
      onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
      extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
      metadata.resolve({ anthropic: { sessionId: final.session_id, totalCostUsd: final.total_cost_usd } });
      resultResponse.resolve(response(text, invocationId, "claude-code"));
    } catch (error) {
      if (toolGate?.didReachLimit() === true || toolGate?.didCompleteVisibleMessage() === true) {
        const finalUsage = (final as unknown as Loose | undefined)?.usage ?? {};
        const input = typeof finalUsage.input_tokens === "number" ? finalUsage.input_tokens : 0;
        const output = typeof finalUsage.output_tokens === "number" ? finalUsage.output_tokens : 0;
        const cacheRead = typeof finalUsage.cache_read_input_tokens === "number" ? finalUsage.cache_read_input_tokens : 0;
        const cacheWrite = typeof finalUsage.cache_creation_input_tokens === "number" ? finalUsage.cache_creation_input_tokens : 0;
        onUsage?.({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
        usage.resolve({ promptTokens: input, completionTokens: output, totalTokens: input + output });
        extendedUsage.resolve({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, maxTokens: 0 });
        metadata.resolve({ anthropic: { ...(typeof final?.session_id === "string" ? { sessionId: final.session_id } : {}), ...(typeof final?.total_cost_usd === "number" ? { totalCostUsd: final.total_cost_usd } : {}) } });
        resultResponse.resolve(response("", invocationId, "claude-code"));
        return;
      }
      const diagnostic = formatClaudeProviderFailure({ final, processError: error, apiErrorStatus, retryAttempt, retryMax, stderr, timedOut, timeoutMs });
      const failure = new Error(diagnostic, { cause: error });
      usage.reject(failure); extendedUsage.reject(failure); metadata.reject(failure); resultResponse.reject(failure); throw failure;
    } finally {
      clearTimeout(timeout);
      if (finalVisibleMessageStopTimer != null) clearTimeout(finalVisibleMessageStopTimer);
      activeQuery = undefined;
    }
  })();
  return { fullStream, response: resultResponse.promise, usage: usage.promise, extendedUsage: extendedUsage.promise, providerMetadata: metadata.promise, invocationId: Promise.resolve(invocationId) };
}

function toToolSet(definitions: readonly Loose[] | undefined, executeTool?: RoutedToolExecutor): ToolSet | undefined {
  if (definitions == null || definitions.length === 0) return undefined;
  const tools: ToolSet = {};
  for (const definition of definitions) {
    if (typeof definition.name !== "string" || definition.name.length === 0) continue;
    const parameters = definition.inputSchema ?? definition.parameters;
    if (parameters == null) continue;
    const routedTool: any = {
      ...(typeof definition.description === "string" ? { description: definition.description } : {}),
      parameters: jsonSchema(parameters),
    };
    if (executeTool != null) routedTool.execute = async (args: unknown, options: { toolCallId: string }) => await executeTool(definition, args, options.toolCallId);
    tools[definition.name] = tool(routedTool);
  }
  return Object.keys(tools).length === 0 ? undefined : tools;
}

function openRouterExecutor(prompt: RoutedProviderPrompt, invocationId: string, definitions?: readonly Loose[], executeTool?: RoutedToolExecutor, onUsage?: (usage: UsageRecord) => void) {
  const id = process.env.SAND_OPENROUTER_MODEL?.trim() || storedInferenceModel("openrouter") || "openai/gpt-5.2";
  const model: LanguageModelV1 = createOpenAI({ apiKey: openRouterCredential(), baseURL: "https://openrouter.ai/api/v1", compatibility: "compatible", name: "openrouter", headers: { "HTTP-Referer": "https://github.com/grok-bot-reconstructed", "X-Title": "Grok Bot Reconstructed" } }).chat(id as any);
  const tools = toToolSet(definitions, executeTool);
  const result = streamText({ model, system: prompt.systemPrompt, messages: prompt.conversationMessages as CoreMessage[], ...(tools === undefined ? {} : { tools }), toolCallStreaming: true, maxSteps: tools === undefined ? 1 : 8 });
  const extendedUsage = result.usage.then(value => ({ inputTokens: value.promptTokens, outputTokens: value.completionTokens, cacheReadTokens: 0, cacheWriteTokens: 0, maxTokens: 0 }));
  if (onUsage != null) void extendedUsage.then(onUsage);
  return { fullStream: result.fullStream, response: result.response, usage: result.usage, extendedUsage, providerMetadata: result.providerMetadata, invocationId: Promise.resolve(invocationId) };
}

class ProviderPromptExecutor extends BasePromptExecutor<ProviderMessage> {
  constructor(readonly provider: RoutedProvider, initialMessages?: readonly ProviderMessage[], readonly onUsage?: (usage: UsageRecord) => void) { super(new BasePromptBuilder(initialMessages)); }
  stream(_ctx: unknown, invocationId = crypto.randomUUID(), definitions?: readonly Loose[]) {
    const prompt = composeRoutedProviderPrompt(this.getMessages());
    if (this.provider === "cursor") return cursorAgentExecutor(prompt, invocationId, definitions, undefined, undefined, this.onUsage);
    if (this.provider === "codex") return codexExecutor(prompt, invocationId, definitions, undefined, this.onUsage);
    if (this.provider === "claude-code") return claudeExecutor(prompt, invocationId, this.onUsage);
    if (this.provider === "opencode") return openCodeExecutor(prompt, invocationId, definitions, undefined, this.onUsage);
    return openRouterExecutor(prompt, invocationId, definitions, undefined, this.onUsage);
  }
}

export function createProviderPromptSession(provider: RoutedProvider): { getModelId(): string; getExecutor(state?: unknown): PromptExecutor } {
  const modelId = provider === "cursor"
    ? configuredCursorAgentModel() ?? "cursor-agent"
    : provider === "codex"
      ? configuredCodexModel()
      : provider === "claude-code"
        ? process.env.SAND_CLAUDE_MODEL?.trim() || storedInferenceModel("claude-code") || "claude-code"
        : provider === "opencode"
          ? configuredOpenCodeModel()
          : process.env.SAND_OPENROUTER_MODEL?.trim() || storedInferenceModel("openrouter") || "openai/gpt-5.2";
  return { getModelId: () => modelId, getExecutor: state => new ProviderPromptExecutor(provider, Array.isArray(state) ? state as ProviderMessage[] : undefined, usage => recordRoutedUsage(provider, usage)) };
}

export async function runRoutedProviderText(provider: SandInferenceProvider, messages: readonly ProviderMessage[], options?: {
  readonly mcpServerUrl?: string;
  readonly tools?: readonly Loose[];
  readonly executeTool?: RoutedToolExecutor;
  readonly onTextDelta?: (delta: string, accumulated: string) => void;
  readonly systemPromptAddition?: string;
}): Promise<string> {
  const startedAt = performance.now();
  const invocationId = crypto.randomUUID();
  const onUsage = (usage: UsageRecord) => recordRoutedUsage(provider, usage);
  const prompt = composeRoutedProviderPrompt(messages, options?.systemPromptAddition);
  const result = provider === "cursor"
      ? cursorAgentExecutor(prompt, invocationId, options?.tools, options?.mcpServerUrl, options?.executeTool, onUsage)
    : provider === "codex"
      ? codexExecutor(prompt, invocationId, options?.tools, options?.executeTool, onUsage, options?.mcpServerUrl)
    : provider === "claude-code"
      ? claudeExecutor(prompt, invocationId, onUsage, options?.mcpServerUrl)
      : provider === "opencode"
        ? openCodeExecutor(prompt, invocationId, options?.tools, options?.mcpServerUrl, onUsage)
      : openRouterExecutor(prompt, invocationId, options?.tools, options?.executeTool, onUsage);
  let text = "";
  let firstTokenMs: number | undefined;
  try {
    for await (const event of result.fullStream) {
      if (event.type === "text-delta" && typeof event.textDelta === "string") {
        firstTokenMs ??= performance.now() - startedAt;
        text += event.textDelta;
        options?.onTextDelta?.(event.textDelta, text);
      }
    }
    await result.response;
    reportInferenceDebug({ provider, phase: "provider", durationMs: Math.round(performance.now() - startedAt), ...(firstTokenMs === undefined ? {} : { firstTokenMs: Math.round(firstTokenMs) }), outcome: "ok" });
    return text;
  } catch (error) {
    reportInferenceDebug({ provider, phase: "provider", durationMs: Math.round(performance.now() - startedAt), ...(firstTokenMs === undefined ? {} : { firstTokenMs: Math.round(firstTokenMs) }), outcome: "error" });
    throw error;
  }
}
