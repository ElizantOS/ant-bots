import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, transform } from "esbuild";
import { patchOriginalAccountMenu, patchOriginalOnboardingFallback, patchOriginalSettingsPanel, patchOriginalSignIn, patchOriginalWindowChrome } from "../scripts/lib/router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadInferenceRouterModule() {
  const source = await readFile(path.join(repoRoot, "source/shared/inference-router.ts"), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

async function loadProviderSessionModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-provider-session-errors-"));
  const output = path.join(temporary, "provider-session.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/provider-session.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const module = await import(`${pathToFileURL(output).href}?${Date.now()}`);
  return { module, dispose: () => rm(temporary, { recursive: true, force: true }) };
}

test("provider override, local CLI identity, and synthetic account identity are explicit", async () => {
  const router = await loadInferenceRouterModule();
  assert.equal(router.resolveSandInferenceProviderOverride({ SAND_INFERENCE_PROVIDER: "codex" }), "codex");
  assert.equal(router.resolveSandInferenceProviderOverride({ SAND_INFERENCE_PROVIDER: " OPENROUTER " }), "openrouter");
  assert.equal(router.resolveSandInferenceProviderOverride({ SAND_INFERENCE_PROVIDER: "unknown" }), null);
  assert.equal(router.resolveSandInferenceProviderDefault({ isPackaged: true, cursorAgentAvailable: true, codexAuthenticated: true }), "cursor");
  assert.equal(router.resolveSandInferenceProviderDefault({ isPackaged: true, cursorAgentAvailable: false, codexAuthenticated: true }), "codex");
  assert.equal(router.resolveSandInferenceProviderDefault({ isPackaged: false, cursorAgentAvailable: true, codexAuthenticated: true }), "cursor");
  assert.equal(router.resolveSandInferenceProviderDefault({ stored: "cursor", isPackaged: true, cursorAgentAvailable: false, codexAuthenticated: true }), "cursor");
  assert.deepEqual(router.createCursorAgentAuthStatus(), {
    kind: "logged-in",
    authId: "router:cursor-agent",
    displayName: "Cursor Agent",
    isAnysphereUser: false,
    externalProvider: "cursor-agent",
  });
  assert.equal(router.isExternalSandInferenceProvider("claude-code"), true);
  assert.equal(router.isExternalSandInferenceProvider("opencode"), true);
  assert.equal(router.isExternalSandInferenceProvider("cursor"), false);
  assert.deepEqual(router.createExternalRouterAuthStatus("codex"), {
    kind: "logged-in",
    authId: "router:codex",
    displayName: "Codex provider",
    isAnysphereUser: false,
    externalProvider: "codex",
  });
});

test("sign-in surface offers local CLIs and external providers without a website login", () => {
  const signIn = 'function gjn(n){return p.jsxs(p.Fragment,{children:[p.jsx(p0t,{autoFocus:!0,disabled:!s.isLoaded,onClick:r,trailingIcon:"arrow-right",children:"Sign in"}),s.error!=null?p.jsx(yjn,{message:s.error}):null]})}';
  const patched = patchOriginalSignIn(signIn);
  assert.match(patched, /RRouterSignInChoice/);
  assert.match(patched, /Claude Code/);
  assert.match(patched, /Codex/);
  assert.match(patched, /Cursor Agent/);
  assert.match(patched, /OpenCode/);
  assert.match(patched, /OpenRouter/);
  assert.match(patched, /window\.location\.reload\(\)/);
  assert.doesNotMatch(patched, /children:"Sign in"/);
});

test("CP account control is replaced by a direct Settings button", () => {
  const source = 'function Xln(n){const z=1,{reading:b,refresh:x}=jMt();let O;e[2]!==P||e[3]!==I||e[4]!==x?(O=Ne=>{d(Ne),Ne&&P&&x(),Ne&&I!=null&&dae({surface:"account_menu",kind:"ready",targetVersion:I.version})},e[2]=P,e[3]=I,e[4]=x,e[5]=O):O=e[5];let te;e[26]!==F||e[27]!==P||e[28]!==b?(te=P&&b!=null?p.jsx(Qln,{onChangeLimit:F,reading:b}):null,e[26]=F,e[27]=P,e[28]=b,e[29]=te):te=e[29];let xe;e[45]!==ee||e[46]!==te||e[47]!==ne||e[48]!==Z||e[49]!==se||e[50]!==Q||e[51]!==ce?(xe=p.jsxs(It.Section,{children:[ee,te,ne,Z,se,Q,ce]}),e[45]=ee,e[46]=te,e[47]=ne,e[48]=Z,e[49]=se,e[50]=Q,e[51]=ce,e[52]=xe):xe=e[52];}function Qln(n){}';
  const patched = patchOriginalAccountMenu(source);
  assert.doesNotMatch(patched, /jMt\(\)/);
  assert.match(patched, /aria-label":"Settings"/);
  assert.match(patched, /onClick:\(\)=>e\("general"\)/);
  assert.match(patched, /icon:"gear"/);
  assert.match(patched, /p\.jsx\(yo,\{content:"Settings"/);
  assert.match(patched, /shape:"circle"/);
  assert.match(patched, /size:"md"/);
  assert.match(patched, /isCollapsed:s/);
  assert.match(patched, /Xbe\.newButton/);
  assert.match(patched, /sand-agents-sidebar__settings-icon/);
  assert.match(patched, /children:\"Settings\"/);
  assert.match(patched, /title:\"Settings\"/);
  assert.doesNotMatch(patched, /It\.Section/);
});

test("original Settings control tracks the sidebar collapsed state like New", async () => {
  const source = await readFile(path.join(repoRoot, "src/app/dist/renderer/assets/index-UbX-y3il.js"), "utf8");
  const patched = patchOriginalAccountMenu(source);
  assert.match(patched, /e\[38\]!==h\|\|e\[39\]!==s\?\(I=O=>p\.jsx\(Xln/);
  assert.match(patched, /shape:"circle"/);
  assert.match(patched, /size:"md"/);
});

test("macOS window controls stay compact and interactive", () => {
  const source = 'function xPe({isOverlayTone:n=!1}){const{isFullscreen:e,isMaximized:t}=t4e(),{platform:s}=Hse(),r=bNe();if(s==="darwin")return null;return s;}function Ipe(){}';
  const patched = patchOriginalWindowChrome(source);
  assert.match(patched, /sand-window-controls--mac/);
  assert.match(patched, /gap:"4px"/);
  assert.match(patched, /aria-label":"Close"/);
  assert.match(patched, /r\.toggleMaximize\(\)/);
  assert.doesNotMatch(patched, /children:p\.jsx\(bt/);
  assert.doesNotMatch(patched, /if\(s===\"darwin\"\)return null/);
});

test("General settings removes the account card but keeps Agent settings", () => {
  const source = 'function Sa(s){let d;e[1]!==t?(d=a.jsx(re,{title:"Account",children:a.jsx(Vs,{auth:t})}),e[1]=t,e[2]=d):d=e[2];let i,o;i=a.jsx(oa,{}),o=a.jsx(va,{});}Q=x==="general"?a.jsx(Te,{children:a.jsx(Sa,{auth:t})}):null;Z=x==="usage"?a.jsx(Te,{children:a.jsx(Na,{})}):null;';
  const patched = patchOriginalSettingsPanel(source);
  assert.match(patched, /let d=null/);
  assert.match(patched, /i=a\.jsx\(oa,\{\}\),o=null/);
});

test("box transport failures fail open to the shell and keep a retry notice for restored rosters", () => {
  const source = 'const mUn=new Set([Cj,l0e,gNe,h2,d0t]);const oUn={name:"onboarding-account-consult",timeoutMs:1e4},lUn={name:"first-run-boot-gate",timeoutMs:1e4};case"gate-unanswerable":return Uoe(n,{forced:!1,signedIn:e.sessionFact,owedShell:null});const view={showsReconnectNotice:st&&Ue==="error"};function Yzn(n){const e=Qe(),t=jJt(),s=S.useSyncExternalStore(e.roster.snapshots.subscribe,e.roster.snapshots.get,e.roster.snapshots.get);return t.status==="ready"&&(e.accountSlot==null||s.loadState!=="loading"||s.isShowingRestoredRoster)?n.children:t.status==="failed"?p.jsx(Kzn,{}):t.status==="ready"?p.jsx(C0t,{}):null}';
  const patched = patchOriginalOnboardingFallback(source);
  assert.match(patched, /const mUn=new Set\(\[Cj,l0e,gNe,h2,d0t,wPe\]\)/);
  assert.match(patched, /lUn=\{name:"first-run-boot-gate",timeoutMs:2500\}/);
  assert.match(patched, /case"gate-unanswerable":return e\.sessionFact===!0\?\{kind:"shell"/);
  assert.match(patched, /showsReconnectNotice:st&&ht!=null/);
  assert.match(patched, /function RAsyncStartupGate\(n,e,t\)/);
  assert.match(patched, /setTimeout\(\(\)=>r\(!0\),2500\)/);
});

test("Claude provider errors preserve the SDK result diagnostic", async () => {
  const loaded = await loadProviderSessionModule();
  try {
    const format = loaded.module.formatClaudeProviderFailure;
    assert.equal(format({
      final: { subtype: "success", is_error: true, result: "API Error: 503 Service temporarily unavailable." },
      apiErrorStatus: 503,
      retryAttempt: 2,
      retryMax: 2,
    }), "Claude Code: API Error: 503 Service temporarily unavailable. (after 3 attempts)");
    assert.equal(format({
      final: { subtype: "success", is_error: true, result: "Not logged in. Please run /login" },
      processError: new Error("Claude Code process exited with code 1"),
    }), "Claude Code: Not logged in. Please run /login");
    assert.equal(format({ timedOut: true, timeoutMs: 60_000 }), "Claude Code timed out after 60 seconds while waiting for a response.");
  } finally {
    await loaded.dispose();
  }
});

test("Claude routed sessions keep the user's CLI credential source enabled", async () => {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  assert.match(source, /settingSources:\s*\["user"/);
  assert.match(source, /canUseTool: async \(toolName: string/);
  assert.match(source, /toolName\.startsWith\("mcp__grok_bot_plugins__"\)/);
});

test("Claude routed tool gate stops duplicate visible messages", async () => {
  const loaded = await loadProviderSessionModule();
  try {
    const gate = loaded.module.createClaudeRoutedToolGate();
    assert.equal(gate.permission("mcp__grok_bot_plugins__SendMessage", { content: "我先查询一下" }).behavior, "allow");
    assert.equal(gate.permission("mcp__grok_bot_plugins__ListAgents", {}).behavior, "allow");
    assert.equal(gate.permission("mcp__grok_bot_plugins__SendMessage", { content: "结果如下" }).behavior, "allow");
    const duplicate = gate.permission("mcp__grok_bot_plugins__SendMessage", { content: "结果如下" });
    assert.equal(duplicate.behavior, "deny");
    assert.equal(duplicate.interrupt, true);
    assert.equal(gate.didReachLimit(), true);

    const simple = loaded.module.createClaudeRoutedToolGate();
    assert.equal(simple.permission("mcp__grok_bot_plugins__SendMessage", { content: "OK" }).behavior, "allow");
    assert.equal(simple.permission("mcp__grok_bot_plugins__SendMessage", { content: "OK" }).behavior, "deny");
  } finally {
    await loaded.dispose();
  }
});

test("routed providers preserve the original system prompt and strip it from conversation input", async () => {
  const loaded = await loadProviderSessionModule();
  try {
    const composed = loaded.module.composeRoutedProviderPrompt([
      { role: "system", content: "ORIGINAL SYSTEM PROMPT" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "previous answer" },
    ], "AskAgent target context");
    assert.equal(composed.systemPrompt, "ORIGINAL SYSTEM PROMPT\n\nAskAgent target context");
    assert.deepEqual(composed.conversationMessages, [
      { role: "user", content: "hello" },
      { role: "assistant", content: "previous answer" },
    ]);
    assert.equal(composed.conversationText, "USER: hello\n\nASSISTANT: previous answer");
    assert.doesNotMatch(composed.conversationText, /ORIGINAL SYSTEM PROMPT/);
    assert.match(composed.cliPrompt, /^ORIGINAL SYSTEM PROMPT\n\nAskAgent target context/);
  } finally {
    await loaded.dispose();
  }
});

test("routed providers use the canonical original prompt when no system message is present", async () => {
  const loaded = await loadProviderSessionModule();
  try {
    const composed = loaded.module.composeRoutedProviderPrompt([{ role: "user", content: "hello" }]);
    assert.match(composed.systemPrompt, /You are Grok Bot, a warm, concise desktop assistant/);
    assert.match(composed.systemPrompt, /SendMessage is your only voice/);
    assert.equal(composed.conversationText, "USER: hello");
  } finally {
    await loaded.dispose();
  }
});

test("provider transports share one canonical prompt adapter", async () => {
  const source = await readFile(path.join(repoRoot, "source/host/extensions/inference/provider-session.ts"), "utf8");
  for (const executor of ["codexCliExecutor", "codexDirectExecutor", "cursorAgentExecutor", "openCodeExecutor", "claudeExecutor", "openRouterExecutor"]) {
    assert.match(source, new RegExp(`function ${executor}\\(\\s*prompt: RoutedProviderPrompt`));
  }
  assert.doesNotMatch(source, /function (codexCliExecutor|codexDirectExecutor|cursorAgentExecutor|openCodeExecutor|claudeExecutor|openRouterExecutor)\(\s*messages:/);
});

test("original renderer lets local providers send while the box is offline", async () => {
  const source = await readFile(path.join(repoRoot, "src/app/dist/renderer/assets/index-UbX-y3il.js"), "utf8");
  const patched = patchOriginalOnboardingFallback(source);
  assert.match(patched, /RRouterLocalInferenceReady=false/);
  assert.match(patched, /isTransportDown:\(\)=>r\.snapshots\.get\(\)\.transport==="down"&&!RRouterCanSendWithoutBox\(\)/);
  assert.match(patched, /oe=Wtt\(\)\.transport==="connected"\|\|RRouterCanSendWithoutBox\(\)/);
});
