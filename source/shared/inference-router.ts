export const SAND_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "opencode", "openrouter"] as const;
export type SandInferenceProvider = (typeof SAND_INFERENCE_PROVIDERS)[number];
export const SAND_EXTERNAL_INFERENCE_PROVIDERS = ["claude-code", "codex", "opencode", "openrouter"] as const;
export type SandExternalInferenceProvider = (typeof SAND_EXTERNAL_INFERENCE_PROVIDERS)[number];
/** Providers that execute through a local agent CLI on the user's machine. */
export const SAND_LOCAL_CLI_INFERENCE_PROVIDERS = ["cursor", "claude-code", "codex", "opencode"] as const;
export type SandLocalCliInferenceProvider = (typeof SAND_LOCAL_CLI_INFERENCE_PROVIDERS)[number];
export const SAND_INFERENCE_PROVIDER_ENV = "SAND_INFERENCE_PROVIDER";
/** Development-only initial selection; persisted UI choices take precedence. */
export const SAND_INFERENCE_PROVIDER_DEFAULT_ENV = "SAND_INFERENCE_PROVIDER_DEFAULT";

/** Small, provider-safe presets shown before a CLI/API returns its own catalog. */
export const SAND_INFERENCE_MODEL_PRESETS: Readonly<Record<SandInferenceProvider, readonly string[]>> = {
  cursor: ["auto", "gpt-5", "sonnet", "opus"],
  "claude-code": ["sonnet", "opus", "haiku"],
  codex: ["gpt-5.4", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"],
  opencode: ["coding-plan/ark-code-latest", "opencode/big-pickle"],
  openrouter: ["openai/gpt-5.2", "anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro"],
};

export function isExternalSandInferenceProvider(value: unknown): value is SandExternalInferenceProvider {
  return typeof value === "string" && (SAND_EXTERNAL_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function isLocalCliSandInferenceProvider(value: unknown): value is SandLocalCliInferenceProvider {
  return typeof value === "string" && (SAND_LOCAL_CLI_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function resolveSandInferenceProviderOverride(env: Readonly<Record<string, string | undefined>>): SandInferenceProvider | null {
  const value = env[SAND_INFERENCE_PROVIDER_ENV]?.trim().toLowerCase();
  return isSandInferenceProvider(value) ? value : null;
}

/** Prefer an already authenticated local external provider for a fresh packaged profile. */
export function resolveSandInferenceProviderDefault(input: {
  readonly stored?: unknown;
  readonly isPackaged: boolean;
  readonly cursorAgentAvailable: boolean;
  readonly codexAuthenticated: boolean;
  readonly claudeCodeAuthenticated?: boolean;
  readonly openCodeAuthenticated?: boolean;
}): SandInferenceProvider {
  if (isSandInferenceProvider(input.stored)) return input.stored;
  if (input.isPackaged && input.cursorAgentAvailable) return "cursor";
  if (input.isPackaged && input.codexAuthenticated) return "codex";
  if (input.isPackaged && input.claudeCodeAuthenticated) return "claude-code";
  if (input.isPackaged && input.openCodeAuthenticated) return "opencode";
  return "cursor";
}

export function createCursorAgentAuthStatus() {
  return {
    kind: "logged-in" as const,
    authId: "router:cursor-agent",
    displayName: "Cursor Agent",
    isAnysphereUser: false,
    externalProvider: "cursor-agent" as const,
  };
}

export function createExternalRouterAuthStatus(provider: SandExternalInferenceProvider) {
  const label = provider === "claude-code" ? "Claude Code" : provider === "codex" ? "Codex" : provider === "opencode" ? "OpenCode" : "OpenRouter";
  return {
    kind: "logged-in" as const,
    authId: `router:${provider}`,
    displayName: `${label} provider`,
    isAnysphereUser: false,
    externalProvider: provider,
  };
}

export interface SandInferenceRouterUsageProvider {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly lastUsedAt: string | null;
}

export interface SandInferenceRouterUsage {
  readonly schemaVersion: 1;
  readonly providers: Record<SandInferenceProvider, SandInferenceRouterUsageProvider>;
}

export function isSandInferenceProvider(value: unknown): value is SandInferenceProvider {
  return typeof value === "string" && (SAND_INFERENCE_PROVIDERS as readonly string[]).includes(value);
}

export function emptySandInferenceRouterUsage(): SandInferenceRouterUsage {
  const empty = (): SandInferenceRouterUsageProvider => ({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, lastUsedAt: null });
  return { schemaVersion: 1, providers: { cursor: empty(), "claude-code": empty(), codex: empty(), opencode: empty(), openrouter: empty() } };
}
