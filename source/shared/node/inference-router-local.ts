import { existsSync, lstatSync, readFileSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const LOCAL_CLI_STATUS_CACHE_TTL_MS = 60_000;
const LOCAL_CLI_STATUS_PROBE_TIMEOUT_MS = 2_000;

export interface LocalInferenceCliStatus {
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly executablePath: string | null;
}

function firstExecutable(candidates: readonly (string | undefined)[]): string | null {
  for (const candidate of candidates) if (candidate != null && candidate.length > 0 && existsSync(candidate)) return candidate;
  return null;
}

type AuthProbeCache = { path: string; authenticated: boolean; checkedAt: number };

function readFreshAuthProbe(cache: AuthProbeCache | undefined, path: string): boolean | undefined {
  return cache != null && cache.path === path && Date.now() - cache.checkedAt < LOCAL_CLI_STATUS_CACHE_TTL_MS
    ? cache.authenticated
    : undefined;
}

function hasUsableCursorAgentLogin(path: string): boolean {
  const cached = readFreshAuthProbe(cursorAuthProbeCache, path);
  if (cached !== undefined) return cached;
  let authenticated = false;
  try {
    const output = execFileSync(path, ["status", "--format", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LOCAL_CLI_STATUS_PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    authenticated = parsed.isAuthenticated === true || parsed.status === "authenticated";
  } catch {
    authenticated = false;
  }
  cursorAuthProbeCache = { path, authenticated, checkedAt: Date.now() };
  return authenticated;
}

let cursorAuthProbeCache: AuthProbeCache | undefined;

function hasUsableClaudeLogin(path: string): boolean {
  const cached = readFreshAuthProbe(claudeAuthProbeCache, path);
  if (cached !== undefined) return cached;
  let authenticated = false;
  try {
    const output = execFileSync(path, ["auth", "status", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: LOCAL_CLI_STATUS_PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    });
    const parsed = JSON.parse(output) as Record<string, unknown>;
    authenticated = parsed.loggedIn === true;
  } catch {
    authenticated = false;
  }
  claudeAuthProbeCache = { path, authenticated, checkedAt: Date.now() };
  return authenticated;
}

let claudeAuthProbeCache: AuthProbeCache | undefined;

function runAuthProbe(path: string, args: readonly string[], parse: (output: string) => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path, [...args], {
      encoding: "utf8",
      timeout: LOCAL_CLI_STATUS_PROBE_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error != null) {
        resolve(false);
        return;
      }
      try {
        resolve(parse(stdout.toString()));
      } catch {
        resolve(false);
      }
    });
  });
}

const cursorAuthProbePending = new Map<string, Promise<boolean>>();
const claudeAuthProbePending = new Map<string, Promise<boolean>>();

function refreshCursorAuth(path: string): Promise<boolean> {
  const cached = readFreshAuthProbe(cursorAuthProbeCache, path);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = cursorAuthProbePending.get(path);
  if (pending != null) return pending;
  const probe = runAuthProbe(path, ["status", "--format", "json"], (output) => {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return parsed.isAuthenticated === true || parsed.status === "authenticated";
  }).then((authenticated) => {
    cursorAuthProbeCache = { path, authenticated, checkedAt: Date.now() };
    return authenticated;
  });
  cursorAuthProbePending.set(path, probe);
  void probe.finally(() => {
    if (cursorAuthProbePending.get(path) === probe) cursorAuthProbePending.delete(path);
  });
  return probe;
}

function refreshClaudeAuth(path: string): Promise<boolean> {
  const cached = readFreshAuthProbe(claudeAuthProbeCache, path);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = claudeAuthProbePending.get(path);
  if (pending != null) return pending;
  const probe = runAuthProbe(path, ["auth", "status", "--json"], (output) => {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    return parsed.loggedIn === true;
  }).then((authenticated) => {
    claudeAuthProbeCache = { path, authenticated, checkedAt: Date.now() };
    return authenticated;
  });
  claudeAuthProbePending.set(path, probe);
  void probe.finally(() => {
    if (claudeAuthProbePending.get(path) === probe) claudeAuthProbePending.delete(path);
  });
  return probe;
}

function pathCandidates(name: string): string[] {
  return (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, name));
}

export function resolveCodexCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CODEX_PATH, join(home, ".local", "bin", "codex"), join(home, ".codex", "bin", "codex"), ...pathCandidates("codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]);
}

export function resolveCursorAgentCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CURSOR_AGENT_PATH, join(home, ".local", "bin", "cursor-agent"), ...pathCandidates("cursor-agent"), "/opt/homebrew/bin/cursor-agent", "/usr/local/bin/cursor-agent"]);
}

export function resolveOpenCodeCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.OPENCODE_PATH, join(home, ".opencode", "bin", "opencode"), join(home, ".local", "bin", "opencode"), ...pathCandidates("opencode"), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"]);
}

export function resolveClaudeCodeCliPath(): string | null {
  const home = homedir();
  return firstExecutable([process.env.CLAUDE_CODE_PATH, join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude"), ...pathCandidates("claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
}

function hasUsableCodexLogin(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return false;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    return parsed.auth_mode === "chatgpt"
      && typeof parsed.tokens?.access_token === "string" && parsed.tokens.access_token.length > 0
      && typeof parsed.tokens?.refresh_token === "string" && parsed.tokens.refresh_token.length > 0
      && typeof parsed.tokens?.id_token === "string" && parsed.tokens.id_token.length > 0
      && typeof parsed.tokens?.account_id === "string" && parsed.tokens.account_id.length > 0;
  } catch { return false; }
}

function hasUsableOpenCodeLogin(paths: readonly string[]): boolean {
  for (const path of paths) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) continue;
      if (Object.values(parsed as Record<string, unknown>).some((value) => {
        if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
        const entry = value as Record<string, unknown>;
        return typeof entry.key === "string" && entry.key.trim().length > 0
          || typeof entry.access === "string" && entry.access.trim().length > 0;
      })) return true;
    } catch {}
  }
  return false;
}

function openCodeAuthPaths(home: string): string[] {
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  return [
    ...(dataHome == null || dataHome.length === 0 ? [] : [join(dataHome, "opencode", "auth.json")]),
    join(home, ".local", "share", "opencode", "auth.json"),
    join(home, ".config", "opencode", "auth.json"),
  ];
}

export type LocalInferenceProvider = "cursor" | "codex" | "claude-code" | "opencode";

export interface LocalInferenceCliStatusOptions {
  /** Skip synchronous CLI process probes; use the last known result instead. */
  readonly probe?: boolean;
}

export function getLocalInferenceCliStatus(provider?: LocalInferenceProvider, options: LocalInferenceCliStatusOptions = {}): { readonly cursor: LocalInferenceCliStatus; readonly codex: LocalInferenceCliStatus; readonly "claude-code": LocalInferenceCliStatus; readonly opencode: LocalInferenceCliStatus } {
  const home = homedir();
  const cursorPath = resolveCursorAgentCliPath();
  const codexPath = resolveCodexCliPath();
  const claudePath = resolveClaudeCodeCliPath();
  const openCodePath = resolveOpenCodeCliPath();
  const codexAuthPath = join(process.env.CODEX_HOME?.trim() || join(home, ".codex"), "auth.json");
  const hasCodexLogin = hasUsableCodexLogin(codexAuthPath);
  const probe = options.probe !== false;
  const hasCursorLogin = provider == null || provider === "cursor"
    ? cursorPath != null && (probe ? hasUsableCursorAgentLogin(cursorPath) : readFreshAuthProbe(cursorAuthProbeCache, cursorPath) ?? false)
    : false;
  const hasClaudeLogin = provider == null || provider === "claude-code"
    ? claudePath != null && (probe ? hasUsableClaudeLogin(claudePath) : readFreshAuthProbe(claudeAuthProbeCache, claudePath) ?? false)
    : false;
  const hasOpenCodeLogin = provider == null || provider === "opencode"
    ? hasUsableOpenCodeLogin(openCodeAuthPaths(home))
    : false;
  return {
    // Cursor Agent owns its authentication separately from Grok Bot's Cursor
    // website session; status is read from the CLI and cached briefly.
    cursor: { installed: cursorPath != null, authenticated: hasCursorLogin, executablePath: cursorPath },
    // Codex inference is a Grok Bot-owned HTTP transport authenticated by the
    // existing Codex login. The CLI binary is not in the request path.
    codex: { installed: codexPath != null, authenticated: hasCodexLogin, executablePath: codexPath },
    "claude-code": { installed: claudePath != null, authenticated: existsSync(join(home, ".claude", ".credentials.json")) || (process.env.ANTHROPIC_API_KEY?.trim().length ?? 0) > 0 || hasClaudeLogin, executablePath: claudePath },
    opencode: { installed: openCodePath != null, authenticated: openCodePath != null && hasOpenCodeLogin, executablePath: openCodePath },
  };
}

/**
 * Return local-provider status without ever starting a CLI process. The main
 * process uses this on latency-sensitive settings IPC paths.
 */
export function getCachedLocalInferenceCliStatus(provider?: LocalInferenceProvider): ReturnType<typeof getLocalInferenceCliStatus> {
  return getLocalInferenceCliStatus(provider, { probe: false });
}

/** Probe local CLI credentials off the Electron click/IPC path and refresh the cache. */
export async function refreshLocalInferenceCliStatus(provider?: LocalInferenceProvider): Promise<ReturnType<typeof getLocalInferenceCliStatus>> {
  const cursorPath = resolveCursorAgentCliPath();
  const claudePath = resolveClaudeCodeCliPath();
  const tasks: Promise<unknown>[] = [];
  if ((provider == null || provider === "cursor") && cursorPath != null) tasks.push(refreshCursorAuth(cursorPath));
  if ((provider == null || provider === "claude-code") && claudePath != null) tasks.push(refreshClaudeAuth(claudePath));
  await Promise.all(tasks);
  return getLocalInferenceCliStatus(provider, { probe: false });
}
