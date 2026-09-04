import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseDevArgs } from "../scripts/dev.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("development renderer modes distinguish clean source from recovered artifacts", () => {
  const defaults = parseDevArgs([], {});
  assert.equal(defaults.renderer, "source");

  const source = parseDevArgs(["--renderer", "source"], {});
  assert.equal(source.renderer, "source");

  const recovered = parseDevArgs(["--renderer=recovered"], {});
  assert.equal(recovered.renderer, "recovered");

  assert.throws(() => parseDevArgs(["--renderer", "unknown"], {}), /Choose source, upstream, or recovered/);
});

test("source development and packaging use the same clean-source entrypoint", async () => {
  const [dev, viteConfig, packageScript, build, packageJson] = await Promise.all([
    readFile(path.join(repoRoot, "scripts/dev.mjs"), "utf8"),
    readFile(path.join(repoRoot, "frontend/vite.config.ts"), "utf8"),
    readFile(path.join(repoRoot, "scripts/package-macos.mjs"), "utf8"),
    readFile(path.join(repoRoot, "scripts/build.mjs"), "utf8"),
    readFile(path.join(repoRoot, "package.json"), "utf8"),
  ]);

  assert.match(dev, /options\.renderer === "source" \? buildCleanDistribution/);
  assert.match(dev, /options\.renderer === "source" \? { sourceOnly: true } : {}/);
  assert.match(dev, /options\.renderer === "source"[\s\S]*?SAND_DEV_RENDERER_ROOT/);
  assert.match(dev, /Source renderer development does not require the pinned DMG/);
  assert.match(dev, /SAND_DEV_RENDERER_MODE = options\.renderer/);
  assert.match(viteConfig, /isUpstreamRenderer \? readUpstreamManifest\(\) : null/);
  assert.doesNotMatch(viteConfig, /isRecoveredRenderer \? null : readUpstreamManifest/);
  assert.match(dev, /\[cleanBuildDir, fidelityCleanBuildDir\]/);
  assert.match(dev, /\[fidelityCleanBuildDir, cleanBuildDir\]/);
  assert.match(packageScript, /: await buildReconstructedAsar\(\)/);
  assert.match(packageScript, /default package is the fully editable clean-source graph/);
  assert.match(build, /: await buildReconstructedAsar\(\)/);
  const productionRenderer = await readFile(path.join(repoRoot, "frontend/src/production/ProductionRenderer.tsx"), "utf8");
  const sidebar = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/sidebar.tsx"), "utf8");
  assert.match(productionRenderer, /onOpenNetwork=\{orgChartIsAvailable \? agentNetworkTrigger : undefined\}/);
  assert.match(sidebar, /onBroadcast == null \? null/);
  const workspaceCss = await readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/view.css"), "utf8");
  assert.match(workspaceCss, /\.sand-chat-header > button\.sand-chat-header__identity \{ color: var\(--cursor-text-primary\); \}/);
  const workspaceIndicator = await readFile(path.join(repoRoot, "frontend/src/recovered/features/window-chrome/workspace-indicator.tsx"), "utf8");
  assert.match(workspaceIndicator, /platform === "darwin"/);
  assert.match(workspaceIndicator, /platform: DesktopBridge\["platform"\]/);
  assert.match(packageJson, /"build:source": "node scripts\/build\.mjs --source"/);
  assert.match(packageJson, /"package:source": "npm run check && node scripts\/package-macos\.mjs --source"/);
});

test("renderer vendor boundaries use the pinned npm dependencies", async () => {
  const [emoji, math, pdf, spreadsheet, mermaid, manifest, packageJson] = await Promise.all([
    readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/cards/transcript-card/emoji-catalog.ts"), "utf8"),
    readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/math.tsx"), "utf8"),
    readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/pdf-viewer.tsx"), "utf8"),
    readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/spreadsheet-viewer.tsx"), "utf8"),
    readFile(path.join(repoRoot, "frontend/src/recovered/features/conversation/workspace/mermaid.tsx"), "utf8"),
    readFile(path.join(repoRoot, "frontend/manifests/renderer-runtime-assets.json"), "utf8").then(JSON.parse),
    readFile(path.join(repoRoot, "package.json"), "utf8"),
  ]);

  assert.match(emoji, /import\("emojibase-data\/en\/data\.json"/);
  assert.match(math, /import\("katex"\)/);
  assert.match(pdf, /import\("pdfjs-dist"\)/);
  assert.match(spreadsheet, /import\("xlsx"\)/);
  assert.match(mermaid, /import\("mermaid"\)/);
  for (const source of [emoji, math, pdf, spreadsheet, mermaid]) {
    assert.doesNotMatch(source, /\/upstream\/assets\/(?:compact|messages|iamcal|emojibase|pdf-WLg|pdf\.worker|min|xlsx-CNer|katex-DHM|mermaid\.core)/);
  }
  assert.equal(manifest.immutableAssets, undefined);
  assert.match(packageJson, /"xlsx": "0\.18\.5"/);
});
