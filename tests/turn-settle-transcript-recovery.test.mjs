import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const output = path.join(repoRoot, ".build", "test-turn-settle-transcript-recovery.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/runner/turn-settle.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return import(`${pathToFileURL(output).href}?${Date.now()}`);
}

test("turn settle recovers a journal before its first checkpoint", async () => {
  const { createTurnSettle } = await loadModule();
  const calls = [];
  const blobStore = { name: "blob-store" };
  const mirror = {
    recover: async (...args) => calls.push(["recover", ...args]),
    prepareCheckpoint: async (...args) => calls.push(["prepare", ...args]),
    abortCheckpoint: async (...args) => calls.push(["abort", ...args]),
    commitCheckpoint: async (...args) => calls.push(["commit", ...args]),
    skipCheckpoint: async (...args) => calls.push(["skip", ...args]),
  };
  const host = {
    isSubagentRunner: false,
    transcriptMirror: mirror,
    getTranscriptId: () => "agent-1",
    getBlobStore: () => blobStore,
    agentStore: () => ({
      handleCheckpoint: async () => calls.push(["store"]),
      getMetadata: () => undefined,
    }),
    setLocalState: () => {},
    ownsRunner: () => true,
    isRunSuperseded: () => false,
    latestPromptMessages: () => [],
    persistAnnouncedAgentProfile: () => {},
  };
  const settle = createTurnSettle(host, {
    conversationId: "agent-1",
    profilePromptSnapshots: {},
  });
  const base = { turns: [], summaryArchives: [], turnTimings: [] };
  const next = { turns: [new Uint8Array([1])], summaryArchives: [], turnTimings: [] };

  settle.noteBaseState(base);
  await settle.persistStepCheckpoint({ requestId: "step" }, next);
  await settle.persistFinalState({ requestId: "final" }, next);

  assert.deepEqual(calls.map(([kind]) => kind), ["recover", "prepare", "store", "commit", "prepare", "store", "commit"]);
  assert.equal(calls.filter(([kind]) => kind === "recover").length, 1);
  assert.equal(calls[0][2], "agent-1");
  assert.equal(calls[0][4], blobStore);
});
