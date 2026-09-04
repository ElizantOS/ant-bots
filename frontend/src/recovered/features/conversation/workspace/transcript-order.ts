import type { ConversationTranscriptEntry } from "./model";

type TranscriptEntryLike = Pick<ConversationTranscriptEntry, "id"> & { readonly timestampMs?: unknown; readonly composedAtMs?: unknown };

function record(value: unknown): TranscriptEntryLike | null {
  return typeof value === "object" && value != null && !Array.isArray(value)
    ? value as TranscriptEntryLike
    : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function turnOrder(id: string): [number, number] | null {
  const match = /^t(\d+)(u|s(\d+))$/.exec(id);
  if (match == null) return null;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) && turn >= 0 && turn < 1_000_000_000
    ? [turn, match[2] === "u" ? 0 : 1 + Number(match[3] ?? 0)]
    : null;
}

function eventTime(value: TranscriptEntryLike): number | null {
  return numeric(value.composedAtMs) ?? numeric(value.timestampMs);
}

/** Stable chronological merge used by both live events and older pages. */
export function mergeTranscriptEntries(
  currentEntries: readonly ConversationTranscriptEntry[],
  incomingEntries: readonly ConversationTranscriptEntry[],
): ConversationTranscriptEntry[] {
  const merged = new Map<string, { readonly entry: ConversationTranscriptEntry; readonly position: number }>();
  let position = 0;
  for (const entry of currentEntries) {
    if (!merged.has(entry.id)) merged.set(entry.id, { entry, position });
    position += 1;
  }
  for (const entry of incomingEntries) {
    const previous = merged.get(entry.id);
    merged.set(entry.id, { entry, position: previous?.position ?? position });
    position += 1;
  }
  return [...merged.values()]
    .sort((left, right) => {
      const leftTime = eventTime(record(left.entry) ?? { id: left.entry.id });
      const rightTime = eventTime(record(right.entry) ?? { id: right.entry.id });
      if (leftTime != null && rightTime != null && leftTime !== rightTime) return leftTime - rightTime;
      const leftTurn = turnOrder(left.entry.id);
      const rightTurn = turnOrder(right.entry.id);
      if (leftTurn != null && rightTurn != null && (leftTurn[0] !== rightTurn[0] || leftTurn[1] !== rightTurn[1])) {
        return leftTurn[0] - rightTurn[0] || leftTurn[1] - rightTurn[1];
      }
      if (leftTime == null && rightTime != null) return 1;
      if (leftTime != null && rightTime == null) return -1;
      return left.position - right.position;
    })
    .map(({ entry }) => entry);
}
