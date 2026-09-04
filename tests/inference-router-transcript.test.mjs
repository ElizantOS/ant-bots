import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-transcript-"));
  const output = path.join(temporary, "inference-router.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/node-agent-coordinator/inference-router.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("routed transcript preserves structured MCP mention rich text across reload", async () => {
  const loaded = await loadModule();
  try {
    const richText = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [
        { type: "mention", attrs: { id: "mcp:3213107", label: "Gmail" } },
        { type: "text", text: " what's new?" },
      ] }],
    });
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{
          provider: "codex",
          role: "user",
          content: "@Gmail what's new?",
          richText,
          id: "t1u",
          clientNonce: "nonce-1",
          timestampMs: 123,
        }],
      },
    });
    const projected = loaded.module.projectInferenceRouterTranscriptEntry(store.agents.agent[0]);
    assert.equal(projected.richText, richText);
    assert.deepEqual(JSON.parse(projected.richText).content[0].content[0], {
      type: "mention",
      attrs: { id: "mcp:3213107", label: "Gmail" },
    });
  } finally {
    await loaded.dispose();
  }
});

test("routed transcript rejects malformed rich text carriers", async () => {
  const loaded = await loadModule();
  try {
    const store = loaded.module.parseInferenceRouterTranscriptStore({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "@Gmail", richText: {}, id: "t1u", timestampMs: 123 }],
      },
    });
    assert.deepEqual(store.agents.agent, []);
  } finally {
    await loaded.dispose();
  }
});

test("routed transcript merges remote and local history chronologically", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-merge-"));
  try {
    await writeFile(path.join(temporary, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "codex" }));
    await writeFile(path.join(temporary, "inference-router-transcript.json"), JSON.stringify({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "user", content: "local", id: "t0u", timestampMs: 200 }],
      },
    }));
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: () => {},
      dispatchRemote: async (method) => method === "getAgentTranscriptTail"
        ? { entries: [
          { kind: "message", id: "remote-later", role: "user", content: "later", timestampMs: 300 },
          { kind: "message", id: "remote-earlier", role: "user", content: "earlier", timestampMs: 100 },
        ] }
        : [],
    });
    const result = await router.dispatch("getAgentTranscriptTail", { id: "agent", limit: 10 });
    assert.deepEqual(result.value.entries.map(({ id }) => id), ["remote-earlier", "t0u", "remote-later"]);
    const decorated = router.decorateTranscriptEvent({
      type: "snapshot",
      activeAgentId: "agent",
      entries: [{ kind: "message", id: "remote-later", role: "user", content: "later", timestampMs: 300 }],
    });
    assert.deepEqual(decorated.entries.map(({ id }) => id), ["t0u", "remote-later"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("external transcript reads fall back to the local replica when the box is unavailable", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-box-fallback-"));
  try {
    await writeFile(path.join(temporary, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "codex" }));
    await writeFile(path.join(temporary, "inference-router-transcript.json"), JSON.stringify({
      schemaVersion: 2,
      agents: {
        agent: [{ provider: "codex", role: "assistant", content: "local fallback", id: "t0s0", timestampMs: 100 }],
      },
    }));
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: () => {},
      dispatchRemote: async () => { throw new Error("box unavailable"); },
    });
    const tail = await router.dispatch("getAgentTranscriptTail", { id: "agent", limit: 10 });
    assert.deepEqual(tail.value.entries.map(({ id }) => id), ["t0s0"]);
    const window = await router.dispatch("getAgentTranscriptWindow", { id: "agent", limit: 10 });
    assert.deepEqual(window.value.entries.map(({ id }) => id), ["t0s0"]);
    assert.deepEqual(window.value.threadCounts, {});
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("read-only routed agent tools fall back to the last roster during a gateway outage", async () => {
  const loaded = await loadModule();
  try {
    const roster = [
      { id: "source", name: "Coordinator", isGroup: false },
      { id: "target", name: "Researcher", isGroup: false, description: "Finds things" },
      { id: "group", name: "Team", isGroup: true, memberIds: ["source", "target"] },
    ];
    assert.deepEqual(loaded.module.fallbackRoutedAgentRead("ListAgents", "source", roster), [
      { id: "target", name: "Researcher", description: "Finds things" },
    ]);
    assert.deepEqual(loaded.module.fallbackRoutedAgentRead("ListGroups", "source", roster), [{
      id: "group",
      name: "Team",
      members: [{ id: "target", name: "Researcher", description: "Finds things" }],
    }]);
    assert.equal(loaded.module.fallbackRoutedAgentRead("CreateAgent", "source", roster), undefined);
  } finally {
    await loaded.dispose();
  }
});

test("Codex uses direct Responses by default without a CLI or MCP handshake", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-direct-default-"));
  const routerHome = path.join(temporary, "codex-home");
  const previous = {
    provider: process.env.SAND_INFERENCE_PROVIDER,
    home: process.env.CODEX_HOME,
    model: process.env.SAND_CODEX_MODEL,
    mcpMode: process.env.SAND_CODEX_MCP_MODE,
  };
  let responseCount = 0;
  const calls = [];
  const requestBodies = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    assert.equal(request.url, "/responses");
    const parsed = JSON.parse(body);
    requestBodies.push(parsed);
    assert.equal(parsed.tools[0].name, "CreateAgent");
    responseCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: `FAST${responseCount}` })}`,
      "",
      `data: ${JSON.stringify({ type: "response.completed", response: { id: "direct-1", output: [], usage: { input_tokens: 2, output_tokens: 1 } } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await mkdir(routerHome, { recursive: true });
    await writeFile(path.join(routerHome, "config.toml"), [
      'model_provider = "test-router"',
      'model = "gpt-test"',
      "",
      "[model_providers.test-router]",
      `base_url = "http://127.0.0.1:${port}"`,
      'experimental_bearer_token = "configured-router-token"',
      "",
    ].join("\n"));
    process.env.SAND_INFERENCE_PROVIDER = "codex";
    process.env.CODEX_HOME = routerHome;
    process.env.SAND_CODEX_MODEL = "gpt-test";
    delete process.env.SAND_CODEX_MCP_MODE;
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: (family, payload) => events.push([family, payload]),
      dispatchRemote: async (method, args) => {
        calls.push([method, args]);
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "source", name: "Source", isGroup: false }];
        if (method === "listRoutedMcpTools") return [];
        if (method === "listRoutedAgentTools") return [{ name: "CreateAgent", providerIdentifier: "grok-bot-agent-tools", toolName: "CreateAgent", inputSchema: { type: "object" } }];
        throw new Error(`unexpected remote method ${method}`);
      },
    });
    const result = await router.dispatch("sendPrompt", { agentId: "source", prompt: "hello", clientNonce: "direct-default" });
    assert.equal(result.handled, true);
    const deadline = Date.now() + 5_000;
    while (!events.some(([family, payload]) => family === "transcript" && payload.entry?.message?.content === "FAST1") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(events.some(([family, payload]) => family === "transcript" && payload.entry?.message?.content === "FAST1"), true, JSON.stringify(events));
    assert.equal(requestBodies[0].reasoning.effort, "medium");
    await router.dispatch("sendPrompt", { agentId: "source", prompt: "hello again", clientNonce: "direct-default-2" });
    const secondDeadline = Date.now() + 5_000;
    while (!events.some(([family, payload]) => family === "transcript" && payload.entry?.message?.content === "FAST2") && Date.now() < secondDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(events.some(([family, payload]) => family === "transcript" && payload.entry?.message?.content === "FAST2"), true, JSON.stringify(events));
    assert.equal(calls.filter(([method]) => method === "listRoutedMcpTools").length, 1);
    assert.equal(calls.filter(([method]) => method === "listRoutedAgentTools").length, 1);
  } finally {
    if (previous.provider == null) delete process.env.SAND_INFERENCE_PROVIDER;
    else process.env.SAND_INFERENCE_PROVIDER = previous.provider;
    if (previous.home == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.home;
    if (previous.model == null) delete process.env.SAND_CODEX_MODEL;
    else process.env.SAND_CODEX_MODEL = previous.model;
    if (previous.mcpMode == null) delete process.env.SAND_CODEX_MCP_MODE;
    else process.env.SAND_CODEX_MCP_MODE = previous.mcpMode;
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("routed provider can follow the original prompt's SendMessage-first contract", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-send-message-"));
  const routerHome = path.join(temporary, "codex-home");
  const previous = {
    provider: process.env.SAND_INFERENCE_PROVIDER,
    home: process.env.CODEX_HOME,
    model: process.env.SAND_CODEX_MODEL,
  };
  const requestBodies = [];
  let responseCount = 0;
  const events = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const parsed = JSON.parse(body);
    requestBodies.push(parsed);
    responseCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const output = responseCount === 1
      ? [{ type: "function_call", call_id: "send-1", name: "SendMessage", arguments: JSON.stringify({ type: "text", content: "收到，我先查一下。" }) }]
      : [];
    const prefix = responseCount === 1 ? [] : [`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "共有 2 个 Bot" })}`, ""];
    response.end([
      ...prefix,
      `data: ${JSON.stringify({ type: "response.completed", response: { id: `send-${responseCount}`, output, usage: { input_tokens: 4, output_tokens: 2 } } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await mkdir(routerHome, { recursive: true });
    await writeFile(path.join(temporary, "settings.json"), JSON.stringify({ version: 1, inferenceProvider: "codex" }));
    await writeFile(path.join(routerHome, "config.toml"), [
      'model_provider = "test-router"',
      'model = "gpt-test"',
      "",
      "[model_providers.test-router]",
      `base_url = "http://127.0.0.1:${port}"`,
      'experimental_bearer_token = "configured-router-token"',
      "",
    ].join("\n"));
    process.env.SAND_INFERENCE_PROVIDER = "codex";
    process.env.CODEX_HOME = routerHome;
    process.env.SAND_CODEX_MODEL = "gpt-test";
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: (family, payload) => events.push([family, payload]),
      dispatchRemote: async (method) => {
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "source", name: "Source", isGroup: false }];
        if (method === "listRoutedMcpTools" || method === "listRoutedAgentTools") return [];
        throw new Error(`unexpected remote method ${method}`);
      },
    });
    const result = await router.dispatch("sendPrompt", { agentId: "source", prompt: "请调用 ListAgents", clientNonce: "send-message-1" });
    assert.equal(result.handled, true);
    const deadline = Date.now() + 5_000;
    while (!events.some(([family, payload]) => family === "transcript" && payload.entry?.message?.content === "共有 2 个 Bot") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const transcript = events
      .filter(([family, payload]) => family === "transcript" && payload.type === "appended")
      .map(([, payload]) => payload.entry?.message?.content)
      .filter((content) => typeof content === "string");
    assert.deepEqual(transcript.slice(-2), ["收到，我先查一下。", "共有 2 个 Bot"], JSON.stringify(events));
    assert.match(requestBodies[0].instructions, /You are Grok Bot, a warm, concise desktop assistant/);
    assert.match(requestBodies[0].instructions, /SendMessage is your only voice/);
    assert.equal(requestBodies[0].tools.some((tool) => tool.name === "SendMessage"), true);
  } finally {
    if (previous.provider == null) delete process.env.SAND_INFERENCE_PROVIDER;
    else process.env.SAND_INFERENCE_PROVIDER = previous.provider;
    if (previous.home == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous.home;
    if (previous.model == null) delete process.env.SAND_CODEX_MODEL;
    else process.env.SAND_CODEX_MODEL = previous.model;
    await new Promise((resolve) => server.close(() => resolve()));
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});

test("external routing merges agent tools and dispatches them with the source id", async () => {
  const loaded = await loadModule();
  try {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-agent-tools-"));
    const routerHome = path.join(temporary, "codex-home");
    await mkdir(routerHome, { recursive: true });
    const fakeCodex = path.join(temporary, "fake-codex.mjs");
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const config = await readFile(process.env.CODEX_HOME + "/config.toml", "utf8");
if (!config.includes('model_provider = "grok-router"') || !config.includes('wire_api = "responses"') || !config.includes('experimental_bearer_token = "configured-router-token"')) throw new Error("Codex MCP config did not preserve the configured provider");
const urlLine = config.split("\\n").find((line) => line.trim().startsWith("url = "));
const match = /"([^"]+)"/.exec(urlLine ?? "");
if (!match) throw new Error("MCP URL was not registered in Codex config");
const url = match[1];
const request = async (method, params) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.random(), method, ...(params === undefined ? {} : { params }) }),
  });
  if (method === "notifications/initialized") return null;
  return await response.json();
};
await request("initialize", {});
await request("notifications/initialized");
const listed = await request("tools/list", {});
const tool = listed.result.tools.find((candidate) => candidate.name === "ListAgents");
if (!tool) throw new Error("ListAgents was not exposed by the routed MCP server");
const called = await request("tools/call", { name: tool.name, arguments: {} });
if (!called.result.content.some((item) => item.text === "agent tool result")) throw new Error("routed agent MCP result was not returned: " + JSON.stringify(called));
process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Target" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 5 } }) + "\\n");
`, { encoding: "utf8", mode: 0o700 });
    await chmod(fakeCodex, 0o700);
    await writeFile(path.join(routerHome, "config.toml"), [
      'model_provider = "test-router"',
      'model = "gpt-test"',
      '',
      '[model_providers.test-router]',
      'base_url = "http://127.0.0.1:1"',
      'experimental_bearer_token = "configured-router-token"',
      '',
    ].join("\n"));
    const calls = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: (family, payload) => events.push([family, payload]),
      dispatchRemote: async (method, args) => {
        calls.push([method, args]);
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "source", name: "Source", isGroup: false }, { id: "target", name: "Target", isGroup: false }];
        if (method === "listRoutedMcpTools") return [];
        if (method === "listRoutedAgentTools") return [{ name: "ListAgents", providerIdentifier: "grok-bot-agent-tools", toolName: "ListAgents", description: "List agents", inputSchema: { type: "object" } }];
        if (method === "executeRoutedAgentTool") {
          assert.equal(args.name, "ListAgents");
          assert.equal(args.providerIdentifier, "grok-bot-agent-tools");
          assert.equal(args.toolName, "ListAgents");
          assert.deepEqual(args.inputSchema, { type: "object" });
          assert.equal(args.description, "List agents");
          assert.deepEqual(args.args, {});
          assert.equal(typeof args.toolCallId, "string");
          assert.equal(args.agentId, "source");
          assert.equal(args.clientNonce, "nonce-1");
          return "agent tool result";
        }
        throw new Error(`unexpected remote method ${method}`);
      },
      now: () => 123,
    });
    const originalProvider = process.env.SAND_INFERENCE_PROVIDER;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalCodexModel = process.env.SAND_CODEX_MODEL;
    const originalCodexPath = process.env.CODEX_PATH;
    const originalCodexMcpMode = process.env.SAND_CODEX_MCP_MODE;
    process.env.SAND_INFERENCE_PROVIDER = "codex";
    process.env.CODEX_HOME = routerHome;
    process.env.SAND_CODEX_MODEL = "gpt-test";
    process.env.CODEX_PATH = fakeCodex;
    process.env.SAND_CODEX_MCP_MODE = "cli";
    try {
      const result = await router.dispatch("sendPrompt", { agentId: "source", prompt: "ask", clientNonce: "nonce-1" });
      assert.equal(result.handled, true);
      const deadline = Date.now() + 10_000;
      while (!calls.some(([method]) => method === "executeRoutedAgentTool") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      if (originalProvider == null) delete process.env.SAND_INFERENCE_PROVIDER;
      else process.env.SAND_INFERENCE_PROVIDER = originalProvider;
      if (originalCodexHome == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      if (originalCodexModel == null) delete process.env.SAND_CODEX_MODEL;
      else process.env.SAND_CODEX_MODEL = originalCodexModel;
      if (originalCodexPath == null) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = originalCodexPath;
      if (originalCodexMcpMode == null) delete process.env.SAND_CODEX_MCP_MODE;
      else process.env.SAND_CODEX_MCP_MODE = originalCodexMcpMode;
    }
    assert.deepEqual(calls.find(([method]) => method === "listRoutedAgentTools"), ["listRoutedAgentTools", { agentId: "source" }], JSON.stringify(events));
    const executeCall = calls.find(([method]) => method === "executeRoutedAgentTool");
    assert.equal(executeCall?.[0], "executeRoutedAgentTool");
    assert.equal(typeof executeCall?.[1]?.toolCallId, "string");
    assert.equal(executeCall?.[1]?.agentId, "source");
    await rm(temporary, { recursive: true, force: true });
  } finally {
    await loaded.dispose();
  }
});

test("Codex MCP routing synchronously returns an AskAgent answer", async () => {
  const loaded = await loadModule();
  try {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-ask-agent-"));
    const routerHome = path.join(temporary, "codex-home");
    await mkdir(routerHome, { recursive: true });
    const fakeCodex = path.join(temporary, "fake-codex.mjs");
    await writeFile(fakeCodex, `#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const config = await readFile(process.env.CODEX_HOME + "/config.toml", "utf8");
let prompt = "";
for await (const chunk of process.stdin) prompt += String(chunk);
const urlLine = config.split("\\n").find((line) => line.trim().startsWith("url = "));
const url = /"([^"]+)"/.exec(urlLine ?? "")?.[1];
if (!url) throw new Error("MCP URL was not registered in Codex config");
const request = async (method, params) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.random(), method, ...(params === undefined ? {} : { params }) }),
  });
  if (method === "notifications/initialized") return null;
  return await response.json();
};
await request("initialize", {});
await request("notifications/initialized");
const listed = await request("tools/list", {});
const tool = listed.result.tools.find((candidate) => candidate.name === "AskAgent");
if (!prompt.includes("answering a synchronous question")) {
  if (!tool) throw new Error("AskAgent was not exposed by the routed MCP server");
  const called = await request("tools/call", { name: tool.name, arguments: { target_id: "target", question: "What is the answer?" } });
  if (!called.result.content.some((item) => item.text === "TARGET_ANSWER")) throw new Error("AskAgent did not return the target answer: " + JSON.stringify(called));
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "MAIN_AFTER_ASK" } }) + "\\n");
} else {
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "TARGET_ANSWER" } }) + "\\n");
}
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 20, output_tokens: 5 } }) + "\\n");
`, { encoding: "utf8", mode: 0o700 });
    await chmod(fakeCodex, 0o700);
    await writeFile(path.join(routerHome, "config.toml"), [
      'model_provider = "test-router"',
      'model = "gpt-test"',
      '',
      '[model_providers.test-router]',
      'base_url = "http://127.0.0.1:1"',
      'experimental_bearer_token = "configured-router-token"',
      '',
    ].join("\n"));
    const calls = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: (family, payload) => events.push([family, payload]),
      dispatchRemote: async (method, args) => {
        calls.push([method, args]);
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [
          { id: "source", name: "Source", description: "Coordinates" },
          { id: "target", name: "Target", description: "Answers questions" },
        ];
        if (method === "listRoutedMcpTools") return [];
        if (method === "listRoutedAgentTools") return [{
          name: "AskAgent",
          providerIdentifier: "grok-bot-agent-tools",
          toolName: "AskAgent",
          description: "Ask another agent",
          inputSchema: { type: "object" },
        }];
        if (method === "executeRoutedAgentTool") throw new Error("AskAgent should be handled by the coordinator");
        throw new Error(`unexpected remote method ${method}`);
      },
      now: () => 123,
    });
    const originalProvider = process.env.SAND_INFERENCE_PROVIDER;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalCodexModel = process.env.SAND_CODEX_MODEL;
    const originalCodexPath = process.env.CODEX_PATH;
    const originalCodexMcpMode = process.env.SAND_CODEX_MCP_MODE;
    process.env.SAND_INFERENCE_PROVIDER = "codex";
    process.env.CODEX_HOME = routerHome;
    process.env.SAND_CODEX_MODEL = "gpt-test";
    process.env.CODEX_PATH = fakeCodex;
    process.env.SAND_CODEX_MCP_MODE = "cli";
    try {
      const result = await router.dispatch("sendPrompt", { agentId: "source", prompt: "Ask the other Bot", clientNonce: "nonce-ask" });
      assert.equal(result.handled, true);
      const deadline = Date.now() + 15_000;
      while (!events.some(([family, payload]) => family === "transcript" && payload.agentId === "source" && payload.entry?.message?.content === "MAIN_AFTER_ASK") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      if (originalProvider == null) delete process.env.SAND_INFERENCE_PROVIDER;
      else process.env.SAND_INFERENCE_PROVIDER = originalProvider;
      if (originalCodexHome == null) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalCodexHome;
      if (originalCodexModel == null) delete process.env.SAND_CODEX_MODEL;
      else process.env.SAND_CODEX_MODEL = originalCodexModel;
      if (originalCodexPath == null) delete process.env.CODEX_PATH;
      else process.env.CODEX_PATH = originalCodexPath;
      if (originalCodexMcpMode == null) delete process.env.SAND_CODEX_MCP_MODE;
      else process.env.SAND_CODEX_MCP_MODE = originalCodexMcpMode;
    }
    assert.equal(events.some(([family, payload]) => family === "transcript" && payload.agentId === "source" && payload.entry?.message?.content === "MAIN_AFTER_ASK"), true, JSON.stringify({ events, calls }));
    assert.equal(events.some(([family, payload]) => family === "transcript" && payload.agentId === "target" && payload.entry?.message?.content === "TARGET_ANSWER"), true, JSON.stringify({ events, calls }));
    assert.equal(calls.some(([method]) => method === "executeRoutedAgentTool"), false);
    await rm(temporary, { recursive: true, force: true });
  } finally {
    await loaded.dispose();
  }
});

test("OpenCode routing uses the selected model and routed MCP bridge", async () => {
  const loaded = await loadModule();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-inference-router-opencode-"));
  const fakeOpenCode = path.join(temporary, "fake-opencode.mjs");
  const previous = {
    provider: process.env.SAND_INFERENCE_PROVIDER,
    path: process.env.OPENCODE_PATH,
    model: process.env.SAND_OPENCODE_MODEL,
    dataRoot: process.env.SAND_DATA_ROOT,
  };
  try {
    await writeFile(fakeOpenCode, `#!/usr/bin/env node
import { readFile } from "node:fs/promises";
const args = process.argv.slice(2);
if (args.includes("--prompt")) throw new Error("OpenCode does not accept --prompt; the message must be positional");
const dir = args[args.indexOf("--dir") + 1];
const model = args[args.indexOf("--model") + 1];
const config = JSON.parse(await readFile(dir + "/opencode.json", "utf8"));
if (model !== "agent-plan/ark-code-latest" || config.model !== model) throw new Error("OpenCode model was not forwarded");
const url = config.mcp?.grok_bot?.url;
if (typeof url !== "string") throw new Error("OpenCode MCP bridge was not configured");
const request = async (method, params) => {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Math.random(), method, ...(params === undefined ? {} : { params }) }) });
  if (method === "notifications/initialized") return null;
  return await response.json();
};
await request("initialize", {});
await request("notifications/initialized");
const listed = await request("tools/list", {});
const tool = listed.result.tools.find((candidate) => candidate.name === "ListAgents");
if (!tool) throw new Error("ListAgents was not exposed to OpenCode");
const called = await request("tools/call", { name: tool.name, arguments: {} });
if (!called.result.content.some((item) => item.text.includes("Source"))) throw new Error("OpenCode did not receive the routed tool result");
process.stdout.write(JSON.stringify({ type: "text", sessionID: "opencode-session", part: { type: "text", text: "OPENCODE_OK" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", part: { tokens: { input: 7, output: 3, cache: { read: 1, write: 0 } } } }) + "\\n");
`, { encoding: "utf8", mode: 0o700 });
    await chmod(fakeOpenCode, 0o700);
    process.env.SAND_INFERENCE_PROVIDER = "opencode";
    process.env.OPENCODE_PATH = fakeOpenCode;
    process.env.SAND_OPENCODE_MODEL = "agent-plan/ark-code-latest";
    process.env.SAND_DATA_ROOT = temporary;
    const calls = [];
    const events = [];
    const router = loaded.module.createCoordinatorInferenceRouter({
      dataDir: temporary,
      postEvent: (family, payload) => events.push([family, payload]),
      dispatchRemote: async (method, args) => {
        calls.push([method, args]);
        if (method === "getAgentTranscriptTail") return { entries: [] };
        if (method === "listAgents") return [{ id: "source", name: "Source", isGroup: false }];
        if (method === "listRoutedMcpTools") return [];
        if (method === "listRoutedAgentTools") return [{ name: "ListAgents", providerIdentifier: "grok-bot-agent-tools", toolName: "ListAgents", description: "List agents", inputSchema: { type: "object" } }];
        if (method === "executeRoutedAgentTool") return [{ name: "Source" }];
        throw new Error(`unexpected remote method ${method}`);
      },
    });
    const result = await router.dispatch("sendPrompt", { agentId: "source", prompt: "hello OpenCode", clientNonce: "opencode-1" });
    assert.equal(result.handled, true);
    const deadline = Date.now() + 10_000;
    while (!events.some(([family, payload]) => family === "transcript" && payload.entry?.message?.content === "OPENCODE_OK") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(events.some(([family, payload]) => family === "transcript" && payload.entry?.message?.content === "OPENCODE_OK"), true, JSON.stringify(events));
    assert.equal(calls.some(([method]) => method === "executeRoutedAgentTool"), true);
  } finally {
    if (previous.provider == null) delete process.env.SAND_INFERENCE_PROVIDER;
    else process.env.SAND_INFERENCE_PROVIDER = previous.provider;
    if (previous.path == null) delete process.env.OPENCODE_PATH;
    else process.env.OPENCODE_PATH = previous.path;
    if (previous.model == null) delete process.env.SAND_OPENCODE_MODEL;
    else process.env.SAND_OPENCODE_MODEL = previous.model;
    if (previous.dataRoot == null) delete process.env.SAND_DATA_ROOT;
    else process.env.SAND_DATA_ROOT = previous.dataRoot;
    await rm(temporary, { recursive: true, force: true });
    await loaded.dispose();
  }
});
