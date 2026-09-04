import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModel() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-renderer-model-"));
  const output = path.join(temporary, "model.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/production/model.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

async function loadDegradedStartup() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-degraded-startup-"));
  const output = path.join(temporary, "degraded-startup.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "frontend/src/production/degraded-startup.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("renderer projects the coordinator agents event envelope", async () => {
  const loaded = await loadModel();
  try {
    const agents = loaded.module.projectRendererAgents({
      activeAgentId: "agent-1",
      agents: [
        { id: "agent-1", name: "New chat", isRunning: true, updatedAt: 20 },
        { id: "agent-2", name: "Night Shift", updatedAt: 10 },
      ],
    }, 30);
    assert.deepEqual(agents.map(({ id, name, isRunning }) => ({ id, name, isRunning })), [
      { id: "agent-1", name: "New chat", isRunning: true },
      { id: "agent-2", name: "Night Shift", isRunning: undefined },
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("renderer projects an agent-upserted event envelope", async () => {
  const loaded = await loadModel();
  try {
    const agent = loaded.module.projectRendererAgent({
      activeAgentId: "agent-1",
      agent: { id: "agent-1", name: "New chat", updatedAt: 20 },
    }, 30);
    assert.equal(agent?.id, "agent-1");
    assert.equal(agent?.name, "New chat");
  } finally {
    await loaded.dispose();
  }
});

test("renderer merges transcript pages by time and replaces duplicate ids", async () => {
  const loaded = await loadModel();
  try {
    const entry = (id, timestampMs, text) => ({ kind: "message", id, role: "assistant", author: "Bot", text, timestampMs });
    const merged = loaded.module.mergeTranscriptEntries(
      [entry("later", 30, "later"), entry("same", 20, "old")],
      [entry("earlier", 10, "earlier"), entry("same", 20, "new")],
    );
    assert.deepEqual(merged.map(({ id, text }) => ({ id, text })), [
      { id: "earlier", text: "earlier" },
      { id: "same", text: "new" },
      { id: "later", text: "later" },
    ]);
  } finally {
    await loaded.dispose();
  }
});

test("renderer baseline keeps local routed and pending messages", async () => {
  const loaded = await loadModel();
  try {
    const entry = (id, timestampMs, text) => ({ kind: "message", id, role: "user", author: "You", text, timestampMs, ...(id === "t1u" ? { routed: true } : {}) });
    const merged = loaded.module.mergeTranscriptBaselineEntries(
      [entry("remote-old", 10, "stale"), entry("t1u", 20, "routed"), entry("pending-call", 30, "pending")],
      [entry("remote-new", 40, "fresh")],
    );
    assert.deepEqual(merged.map(({ id }) => id), ["t1u", "pending-call", "remote-new"]);
  } finally {
    await loaded.dispose();
  }
});

test("degraded startup reads time out with a typed box failure", async () => {
  const loaded = await loadDegradedStartup();
  try {
    await assert.rejects(
      loaded.module.withBoxStartupReadTimeout(new Promise(() => {}), "listAgents", 5),
      (error) => error?.code === "box-startup-timeout" && error?.transportKind === "timeout",
    );
  } finally {
    await loaded.dispose();
  }
});

test("degraded startup accepts only transcript replica envelopes", async () => {
  const loaded = await loadDegradedStartup();
  try {
    const entry = { kind: "message", id: "t0u", role: "user", content: "hello" };
    assert.deepEqual(
      loaded.module.parsePersistedTranscriptReplica(JSON.stringify({ schemaVersion: 1, value: { entries: [entry] } })),
      [entry],
    );
    assert.deepEqual(loaded.module.parsePersistedTranscriptReplica("not-json"), []);
    assert.deepEqual(loaded.module.parsePersistedTranscriptReplica(JSON.stringify({ schemaVersion: 2, value: { entries: [entry] } })), []);
    assert.equal(
      loaded.module.transcriptReplicaPersistenceKey("router:cursor.agent", "agent-1"),
      "sand.client.slice.account.router%3Acursor%2Eagent.transcript.replicas.agent-1",
    );
  } finally {
    await loaded.dispose();
  }
});
