import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";
import { patchOriginalSettingsRegistry } from "../scripts/lib/router-renderer-patch.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const routerSourcePath = path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/router.ts");

async function loadRouterModule() {
  const source = await readFile(routerSourcePath, "utf8");
  const { code: output } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("router provider list and parsing include every supported provider", async () => {
  const router = await loadRouterModule();
  assert.deepEqual(router.ROUTER_PROVIDERS.map(({ id }) => id), ["cursor", "claude-code", "codex", "opencode", "openrouter"]);
  assert.equal(router.parseRouterProviderPreference(null), "cursor");
  assert.equal(router.parseRouterProviderPreference("not-json"), "cursor");
  assert.equal(router.parseRouterProviderPreference(JSON.stringify({ schemaVersion: 1, provider: "unknown" })), "cursor");

  for (const provider of router.ROUTER_PROVIDERS) assert.equal(router.isRouterProviderId(provider.id), true);
});

test("settings registry exposes Router with the native settings icon contract", async () => {
  const source = await readFile(path.join(repoRoot, "frontend/src/recovered/features/settings/overlay/view.tsx"), "utf8");
  assert.match(source, /\{ id: "router", label: "Router", icon: "git-branch" \}/);
  const registry = source.slice(source.indexOf("SETTINGS_SECTIONS"), source.indexOf("settingsSectionsForUsage"));
  assert.doesNotMatch(registry, /Usage & Billing|Updates/);
});

test("settings chunk is warmed before the first Settings click", () => {
  const source = 'const wDn=[{id:"general",label:"General",icon:"settings-gear"},{id:"usage",label:"Usage & Billing",icon:"chart-bars"},{id:"beta",label:"Updates",icon:"cloud-download"}];const $jn=200,Ujn=1;';
  const patched = patchOriginalSettingsRegistry(source);
  assert.match(patched, /const wDn=\[\{id:"general".*\},\{id:"router",label:"Router",icon:"git-branch"\}\]/);
  assert.match(patched, /void import\("\.\/index-BlqerJhg\.js"\)\.catch\(\(\)=>\{\}\);/);
});

test("provider switching keeps CLI probes off the synchronous main-edge path", async () => {
  const source = await readFile(path.join(repoRoot, "source/electron-main/main-edge.ts"), "utf8");
  assert.match(source, /getCachedLocalInferenceCliStatus/);
  assert.match(source, /refreshLocalInferenceCliStatus/);
  assert.match(source, /setInferenceRouter: async \(raw\) =>[\s\S]*refreshInferenceRouterCliStatus\(provider\); return inferenceRouterSnapshot/);
  assert.doesNotMatch(source, /local:\s*getLocalInferenceCliStatus/);
});
