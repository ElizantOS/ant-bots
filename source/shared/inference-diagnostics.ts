import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type InferenceDebugEvent = {
  readonly phase: string;
  readonly provider?: string;
  readonly agentId?: string;
  readonly toolName?: string;
  readonly step?: number;
  readonly toolCount?: number;
  readonly durationMs?: number;
  readonly firstTokenMs?: number;
  readonly outcome?: "ok" | "error";
};

function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function inferenceDebugEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return isEnabled(env.SAND_INFERENCE_DEBUG);
}

/** Emits timings without prompts, arguments, or provider credentials. */
export function reportInferenceDebug(event: InferenceDebugEvent): void {
  if (!inferenceDebugEnabled()) return;
  try {
    const line = `[sand:inference] ${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    process.stderr.write(line);
    const file = process.env.SAND_INFERENCE_DEBUG_FILE?.trim();
    if (file != null && file.length > 0) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, line, { encoding: "utf8", mode: 0o600 });
    }
  } catch {
    // Diagnostics must never affect an inference turn.
  }
}
