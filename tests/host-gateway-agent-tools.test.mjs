import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule(entry) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-host-agent-tools-"));
  const output = path.join(temporary, "module.mjs");
  await build({
    entryPoints: [path.join(repoRoot, entry)],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

function dependencies(manager) {
  const empty = {};
  const extensions = new Map([
    ["transcript", manager],
    ["attachments", empty],
    ["automations", empty],
    ["managed-setup", empty],
    ["settings", empty],
    ["local-tool-permission", empty],
    ["telemetry", { analytics: {} }],
    ["cross-user-sharing", empty],
  ]);
  return {
    extensions: { api: (id) => extensions.get(id) ?? empty },
    hostEvents: { emit() {} },
    decorateForeverBoxStatus: (value) => value,
    getHealth: () => ({ isBusy: false }),
    kickstartIfPending: async () => false,
    requestDiskSaverAudit: async () => false,
    releaseAgentBox: async () => {},
    handleDesktopMcpAuthCompletion: async () => {},
    forgetLocalToolPermission: () => {},
  };
}

test("host gateway exposes routed agent tools with the source agent identity", async () => {
  const loaded = await loadModule("source/host/host-gateway-api.ts");
  try {
    const roster = [
      { id: "source", name: "Coordinator", description: "" },
      { id: "target", name: "Researcher", description: "" },
    ];
    const sent = [];
    const manager = {
      listAgents: async () => roster,
      sendToAgent: async (...args) => {
        sent.push(args);
        return "Sent to Researcher.";
      },
    };
    const api = loaded.module.createHostGatewayApi(dependencies(manager));
    const definitions = await api.listRoutedAgentTools({ agentId: "source" });
    assert.deepEqual(definitions.map(({ name }) => name), ["SendToAgent", "CreateAgent", "AskAgent", "UpdateAgent", "ListAgents", "ListGroups"]);

    const result = await api.executeRoutedAgentTool({
      providerIdentifier: "grok-bot-agent-tools",
      name: "SendToAgent",
      toolName: "SendToAgent",
      agentId: "source",
      args: { target_id: "target", message: "Please investigate this", priority: true },
      toolCallId: "call-1",
    });
    assert.equal(result, "Sent to Researcher.");
    assert.deepEqual(sent, [["source", "target", "Please investigate this", [], true]]);
  } finally {
    await loaded.dispose();
  }
});

test("gateway protocol routes the routed agent tool methods", async () => {
  const loaded = await loadModule("source/host/gateway-protocol.ts");
  try {
    const calls = [];
    const api = {
      listRoutedAgentTools: (args) => { calls.push(["list", args]); return ["tool"]; },
      executeRoutedAgentTool: (args) => { calls.push(["execute", args]); return "ok"; },
    };
    assert.deepEqual(loaded.module.SAND_GATEWAY_COMMANDS.listRoutedAgentTools(api, JSON.stringify({ agentId: "source" })), ["tool"]);
    assert.equal(loaded.module.SAND_GATEWAY_COMMANDS.executeRoutedAgentTool(api, JSON.stringify({ toolCallId: "call-1" })), "ok");
    assert.deepEqual(calls, [["list", { agentId: "source" }], ["execute", { toolCallId: "call-1" }]]);
  } finally {
    await loaded.dispose();
  }
});
