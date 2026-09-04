/**
 * Startup helpers for the renderer's degraded box path. The coordinator port
 * can be alive while the computer gateway is still booting, so reads that are
 * only needed to hydrate the shell must have a short, explicit deadline.
 */
export const BOX_STARTUP_READ_TIMEOUT_MS = 2_500;

export class BoxStartupReadTimeoutError extends Error {
  readonly code = "box-startup-timeout";
  readonly transportKind = "timeout";

  constructor(operation: string, timeoutMs: number) {
    super(`${operation} did not finish within ${timeoutMs}ms`);
    this.name = "BoxStartupReadTimeoutError";
  }
}

export function withBoxStartupReadTimeout<Value>(
  request: Promise<Value>,
  operation: string,
  timeoutMs = BOX_STARTUP_READ_TIMEOUT_MS,
): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoxStartupReadTimeoutError(operation, timeoutMs)), timeoutMs);
  });
  return Promise.race([request, deadline]).finally(() => {
    if (timer != null) clearTimeout(timer);
  });
}

function encodeAccountSlot(accountSlot: string): string {
  return encodeURIComponent(accountSlot).replaceAll(".", "%2E");
}

export function transcriptReplicaPersistenceKey(accountSlot: string, agentId: string): string {
  if (accountSlot.length === 0 || agentId.length === 0) throw new Error("accountSlot and agentId must not be empty");
  return `sand.client.slice.account.${encodeAccountSlot(accountSlot)}.transcript.replicas.${agentId}`;
}

/** Reads the durable transcript replica envelope without trusting its shape. */
export function parsePersistedTranscriptReplica(value: string | null): readonly unknown[] {
  if (value == null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return [];
    const envelope = parsed as { schemaVersion?: unknown; value?: unknown };
    if (envelope.schemaVersion !== 1 || typeof envelope.value !== "object" || envelope.value == null || Array.isArray(envelope.value)) return [];
    const entries = (envelope.value as { entries?: unknown }).entries;
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}
