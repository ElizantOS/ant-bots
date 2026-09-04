import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-routed-agent-tools-"));
  const output = path.join(temporary, "routed-agent-tools.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/agents/routed-agent-tools.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function roster() {
  return [
    { id: "source", name: "Coordinator", description: "Coordinates work", isGroup: false },
    { id: "target", name: "Researcher", description: "Researches topics", isGroup: false },
    { id: "other", name: "Writer", description: "Writes drafts", isGroup: false },
    { id: "group", name: "Team", description: "Shared room", isGroup: true, memberIds: ["source", "target"] },
  ];
}

test("routed agent tools expose create, update, messaging, and discovery", async () => {
  const loaded = await loadModule();
  try {
    const calls = [];
    const owner = loaded.module.createRoutedAgentToolOwner({
      listAgents: async () => roster(),
      createBackgroundAgent: async (profile) => ({ agent: { id: "created", ...profile } }),
      updateAgent: async (id, profile) => ({ id, ...profile }),
      sendToAgent: async (from, to, message, images, priority) => {
        calls.push({ from, to, message, images, priority });
        return "sent";
      },
    });
    const definitions = await owner.listTools("source");
    assert.deepEqual(definitions.map(({ name }) => name), ["SendToAgent", "CreateAgent", "AskAgent", "UpdateAgent", "ListAgents", "ListGroups"]);

    const agents = await owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "ListAgents", toolName: "ListAgents", agentId: "source", args: {}, toolCallId: "call-list" });
    assert.deepEqual(agents.map(({ id }) => id), ["target", "other"]);

    const groups = await owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "ListGroups", toolName: "ListGroups", agentId: "source", args: {}, toolCallId: "call-groups" });
    assert.deepEqual(groups[0].members.map(({ id }) => id), ["target"]);

    const created = await owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "CreateAgent", toolName: "CreateAgent", agentId: "source", args: { name: "Analyst", description: "Finds evidence" }, toolCallId: "call-create" });
    assert.match(created, /created agent "Analyst"/i);

    const secondCreated = await owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "CreateAgent", toolName: "CreateAgent", agentId: "source", args: { name: "Second Analyst" }, toolCallId: "call-create-2" });
    assert.match(secondCreated, /Second Analyst/);

    const updated = await owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "UpdateAgent", toolName: "UpdateAgent", agentId: "source", args: { agent_id: "target", name: "Senior Researcher" }, toolCallId: "call-update" });
    assert.match(updated, /Senior Researcher/);

    const sent = await owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "SendToAgent", toolName: "SendToAgent", agentId: "source", args: { target_id: "target", message: "Please investigate this", priority: true }, toolCallId: "call-send" });
    assert.equal(sent, "sent");
    assert.deepEqual(calls, [{ from: "source", to: "target", message: "Please investigate this", images: [], priority: true }]);
  } finally {
    await loaded.dispose();
  }
});

test("routed agent tools reject self-messaging and group updates", async () => {
  const loaded = await loadModule();
  try {
    const owner = loaded.module.createRoutedAgentToolOwner({
      listAgents: async () => roster(),
      createBackgroundAgent: async () => ({ agent: { id: "created", name: "Created" } }),
      updateAgent: async () => ({ id: "unused", name: "Unused" }),
      sendToAgent: async () => "sent",
    });
    await assert.rejects(
      owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "SendToAgent", toolName: "SendToAgent", agentId: "source", args: { target_id: "source", message: "loop" }, toolCallId: "call-self" }),
      /can't message itself/,
    );
    const result = await owner.execute({ providerIdentifier: "grok-bot-agent-tools", name: "UpdateAgent", toolName: "UpdateAgent", agentId: "source", args: { agent_id: "group", name: "Not a group" }, toolCallId: "call-group" });
    assert.match(result, /No agent found/);
  } finally {
    await loaded.dispose();
  }
});
