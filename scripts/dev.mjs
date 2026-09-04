#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildCleanDistribution, buildFidelityDistribution, cleanBuildDir, fidelityCleanBuildDir } from "./clean-build.mjs";
import {
  buildDir,
  devProfileDir,
  recoveredRendererDir,
  repoRoot,
  sourceAppDir,
} from "./lib/config.mjs";
import { applyOriginalRendererRouterPatch } from "./lib/router-renderer-patch.mjs";

const PROVIDERS = new Set(["cursor", "claude-code", "codex", "opencode", "openrouter"]);
const EXTERNAL_PROVIDERS = new Set(["cursor", "claude-code", "codex", "opencode", "openrouter"]);
const RENDERERS = new Set(["upstream", "source", "recovered"]);
const DEFAULT_VITE_PORT = 5_173;
const DEFAULT_CONTROL_PORT = 62_150;
const devRuntimeDir = path.join(buildDir, "dev-runtime");
const devAppDir = path.join(buildDir, "dev-app");

function usage() {
  return [
    "Usage: npm run dev -- [options]",
    "",
    "Options:",
    "  --provider <name>       cursor, claude-code, codex, opencode, or openrouter (default: cursor)",
    "  --box-runtime <mode>    remote or local-docker (external providers default to local-docker)",
    "  --renderer <mode>       source (default), upstream, or recovered",
    "  --port <number>         Vite port (default: 5173)",
    "  --control-port <number> Dev control port (default: 62150)",
    "  --remote-debugging-port <number> Chromium DevTools port",
    "  --user-data-dir <path>  Isolated development profile",
    "  --keep-onboarding       Keep the first-run onboarding screen",
    "  --no-build              Reuse the last .build/dev-runtime or fidelity runtime",
    "  --help                  Show this help",
  ].join("\n");
}

function requirePort(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${option} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function readOption(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

export function parseDevArgs(argv = [], env = process.env) {
  let provider = env.SAND_INFERENCE_PROVIDER?.trim().toLowerCase() || "cursor";
  let boxRuntime = env.SAND_BOX_RUNTIME?.trim().toLowerCase() || "";
  let renderer = env.SAND_DEV_RENDERER?.trim().toLowerCase() || "source";
  let port = DEFAULT_VITE_PORT;
  let controlPort = DEFAULT_CONTROL_PORT;
  let remoteDebuggingPort = null;
  let userDataDir = env.SAND_DEV_USER_DATA_DIR?.trim() || devProfileDir;
  let noBuild = false;
  let keepOnboarding = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--no-build") {
      noBuild = true;
      continue;
    }
    if (argument === "--keep-onboarding") {
      keepOnboarding = true;
      continue;
    }
    const [inlineOption, inlineValue] = argument.split("=", 2);
    if (inlineOption === "--provider") {
      provider = inlineValue ?? readOption(argv, index++, "--provider");
      continue;
    }
    if (inlineOption === "--box-runtime") {
      boxRuntime = inlineValue ?? readOption(argv, index++, "--box-runtime");
      continue;
    }
    if (inlineOption === "--renderer") {
      renderer = inlineValue ?? readOption(argv, index++, "--renderer");
      continue;
    }
    if (inlineOption === "--port") {
      port = requirePort(inlineValue ?? readOption(argv, index++, "--port"), "--port");
      continue;
    }
    if (inlineOption === "--control-port") {
      controlPort = requirePort(inlineValue ?? readOption(argv, index++, "--control-port"), "--control-port");
      continue;
    }
    if (inlineOption === "--remote-debugging-port") {
      remoteDebuggingPort = requirePort(inlineValue ?? readOption(argv, index++, "--remote-debugging-port"), "--remote-debugging-port");
      continue;
    }
    if (inlineOption === "--user-data-dir") {
      userDataDir = inlineValue ?? readOption(argv, index++, "--user-data-dir");
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  provider = provider.trim().toLowerCase();
  if (!PROVIDERS.has(provider)) throw new Error(`Unsupported provider ${provider}. Choose: ${[...PROVIDERS].join(", ")}.`);
  boxRuntime = boxRuntime.trim().toLowerCase() || (EXTERNAL_PROVIDERS.has(provider) ? "local-docker" : "remote");
  if (boxRuntime !== "remote" && boxRuntime !== "local-docker") throw new Error(`Unsupported box runtime ${boxRuntime}. Choose remote or local-docker.`);
  renderer = renderer.trim().toLowerCase();
  if (!RENDERERS.has(renderer)) throw new Error(`Unsupported renderer ${renderer}. Choose source, upstream, or recovered.`);
  if (!path.isAbsolute(userDataDir)) userDataDir = path.resolve(repoRoot, userDataDir);

  return { help: false, provider, boxRuntime, renderer, port, controlPort, remoteDebuggingPort, userDataDir, noBuild, skipOnboarding: EXTERNAL_PROVIDERS.has(provider) && !keepOnboarding };
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "connection refused";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Vite did not become ready at ${url}: ${lastError}`);
}

async function isLoopbackPortFree(port) {
  return await new Promise((resolve) => {
    const server = createServer();
    const finish = (free) => server.close(() => resolve(free));
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => finish(true));
  });
}

async function findFreeLoopbackPort(preferred, reserved = new Set()) {
  if (!reserved.has(preferred) && await isLoopbackPortFree(preferred)) return preferred;
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address != null ? address.port : 0;
      server.close((error) => error == null && port > 0 ? resolve(port) : reject(error ?? new Error("Could not allocate a loopback port.")));
    });
  });
}

async function configureDevelopmentNoVncPorts(environment, boxRuntime) {
  if (boxRuntime !== "local-docker") return;
  if (environment.SAND_BOX_PRIMARY_NOVNC_PORT == null) {
    environment.SAND_BOX_PRIMARY_NOVNC_PORT = String(await findFreeLoopbackPort(6_080));
  }
  if (environment.SAND_BOX_FORK_NOVNC_PORT == null) {
    environment.SAND_BOX_FORK_NOVNC_PORT = String(await findFreeLoopbackPort(6_081, new Set([Number(environment.SAND_BOX_PRIMARY_NOVNC_PORT)])));
  }
}

async function resolveDevPorts(options) {
  const reserved = new Set();
  const port = await findFreeLoopbackPort(options.port, reserved);
  reserved.add(port);
  const controlPort = await findFreeLoopbackPort(options.controlPort, reserved);
  reserved.add(controlPort);
  const remoteDebuggingPort = options.remoteDebuggingPort == null
    ? null
    : await findFreeLoopbackPort(options.remoteDebuggingPort, reserved);
  return { ...options, port, controlPort, remoteDebuggingPort };
}

function spawnInherited(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  return child;
}

function childExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: 1, signal: null, error }));
    child.once("close", (code, signal) => resolve({ code: code ?? 1, signal, error: null }));
  });
}

function stopChild(child) {
  if (child == null || child.exitCode != null || child.killed) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  }, 3_000);
  timer.unref?.();
}

async function recoverRendererSnapshot(environment) {
  const recoverScript = path.join(repoRoot, "scripts", "recover-frontend.mjs");
  const patchedInputRoot = path.join(buildDir, "recovered-input");
  await rm(patchedInputRoot, { recursive: true, force: true });
  await mkdir(path.join(patchedInputRoot, "dist"), { recursive: true });
  await cp(path.join(sourceAppDir, "dist", "renderer"), path.join(patchedInputRoot, "dist", "renderer"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  // Recover the exact shipped renderer after applying the same deterministic
  // Router/model patch used by the packaged app. This keeps source mode
  // readable without giving it a second visual implementation.
  await applyOriginalRendererRouterPatch({ stageRoot: patchedInputRoot });
  environment.SAND_RECOVER_SOURCE_RENDERER = path.join(patchedInputRoot, "dist", "renderer");
  const child = spawnInherited(process.execPath, [recoverScript], environment);
  const result = await childExit(child);
  if (result.error != null) throw result.error;
  if (result.code !== 0) throw new Error(`Renderer recovery exited with code ${result.code}.`);
  await stat(path.join(recoveredRendererDir, "index.html"));
}

async function materializeDevApp(runtimeRoot, renderer) {
  const packagePath = path.join(sourceAppDir, "package.json");
  await stat(packagePath);
  await stat(path.join(runtimeRoot, "dist", "electron-main", "main.cjs"));
  await rm(devAppDir, { recursive: true, force: true });
  await mkdir(devAppDir, { recursive: true });
  await cp(packagePath, path.join(devAppDir, "package.json"));
  await cp(path.join(runtimeRoot, "dist"), path.join(devAppDir, "dist"), {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
  const runtimeNodeModules = path.join(runtimeRoot, "node_modules");
  if (await exists(runtimeNodeModules)) {
    await cp(runtimeNodeModules, path.join(devAppDir, "node_modules"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  if (renderer === "upstream" || renderer === "recovered") {
    await cp(path.join(sourceAppDir, "dist", "renderer"), path.join(devAppDir, "dist", "renderer"), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  return devAppDir;
}

async function runtimeRootMatchesRenderer(runtimeRoot, renderer) {
  try {
    await stat(path.join(runtimeRoot, "dist", "electron-main", "main.cjs"));
    const manifest = JSON.parse(await readFile(path.join(runtimeRoot, "dist", "reconstruction-build.json"), "utf8"));
    const rendererRuntime = manifest.runtimeComposition?.find((runtime) => runtime.runtime === "renderer");
    const expectedMode = renderer === "source" ? "clean-source" : "checksum-pinned-artifact-runtime";
    return rendererRuntime?.mode === expectedMode;
  } catch {
    return false;
  }
}

async function resolveRuntimeRoot(options) {
  if (!options.noBuild) {
    const build = options.renderer === "source" ? buildCleanDistribution : buildFidelityDistribution;
    const built = await build({ outputRoot: devRuntimeDir, ...(options.renderer === "source" ? { sourceOnly: true } : {}) });
    return built.outputRoot;
  }
  if (await runtimeRootMatchesRenderer(devRuntimeDir, options.renderer)) return devRuntimeDir;
  const fallbackRoots = options.renderer === "source"
    ? [cleanBuildDir, fidelityCleanBuildDir]
    : [fidelityCleanBuildDir, cleanBuildDir];
  for (const fallbackRoot of fallbackRoots) {
    if (await runtimeRootMatchesRenderer(fallbackRoot, options.renderer)) return fallbackRoot;
  }
  throw new Error("No development runtime exists. Run without --no-build first.");
}

async function runDev(options) {
  const requestedPorts = options;
  options = await resolveDevPorts(options);
  for (const [label, requested, selected] of [
    ["Vite", requestedPorts.port, options.port],
    ["control", requestedPorts.controlPort, options.controlPort],
    ["CDP", requestedPorts.remoteDebuggingPort, options.remoteDebuggingPort],
  ]) {
    if (requested != null && selected != null && requested !== selected) {
      console.warn(`[sand] ${label} port ${requested} is busy; using ${selected}`);
    }
  }
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.GROK_BOT_RECONSTRUCTED_DEV ??= "1";
  environment.SAND_DISABLE_UPDATES ??= "1";
  environment.SAND_DISABLE_TELEMETRY ??= "1";
  environment.SAND_DISABLE_ANALYTICS ??= "1";
  // This is only the initial route. Once the user chooses a provider in the
  // UI, SandSettingsStore persists it and it must override the dev default.
  delete environment.SAND_INFERENCE_PROVIDER;
  environment.SAND_INFERENCE_PROVIDER_DEFAULT = options.provider;
  environment.SAND_BOX_RUNTIME = options.boxRuntime;
  environment.SAND_DEV_RENDERER_MODE = options.renderer;
  environment.SAND_DEV_CONTROL_PORT = String(options.controlPort);
  environment.SAND_USER_DATA_DIR = options.userDataDir;
  environment.SAND_DATA_ROOT = path.join(options.userDataDir, "sand-data");
  if (environment.SAND_INFERENCE_DEBUG === "1" && environment.SAND_INFERENCE_DEBUG_FILE == null) {
    environment.SAND_INFERENCE_DEBUG_FILE = path.join(options.userDataDir, "inference-debug.log");
  }
  if (options.renderer === "recovered") {
    await recoverRendererSnapshot(environment);
    environment.SAND_DEV_RENDERER_ROOT = recoveredRendererDir;
    environment.VITE_DEV_SERVER_URL = `http://127.0.0.1:${options.port}/`;
  } else if (options.renderer === "source") {
    // The clean renderer is served directly from frontend/src through Vite.
    // Its production build is already present in the shared runtime root;
    // using the same entrypoint here keeps dev and packaged behavior aligned.
    delete environment.SAND_DEV_RENDERER_ROOT;
    environment.VITE_DEV_SERVER_URL = `http://127.0.0.1:${options.port}/`;
  } else {
    delete environment.SAND_DEV_RENDERER_ROOT;
    delete environment.VITE_DEV_SERVER_URL;
  }
  await configureDevelopmentNoVncPorts(environment, options.boxRuntime);

  const viteBin = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  const electronCli = path.join(repoRoot, "node_modules", "electron", "cli.js");
  await stat(viteBin);
  await stat(electronCli);

  const vite = options.renderer !== "upstream"
    ? spawnInherited(process.execPath, [viteBin, "--config", "frontend/vite.config.ts", "--host", "127.0.0.1", "--port", String(options.port), "--strictPort"], environment)
    : undefined;
  let electron;
  let shuttingDown = false;
  const shutdown = (code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(electron);
    stopChild(vite);
    if (code != null) process.exitCode = code;
  };
  const onSignal = () => shutdown(130);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (vite != null) await waitForHttp(`http://127.0.0.1:${options.port}/`);
    const runtimeRoot = await resolveRuntimeRoot(options);
    const appDir = await materializeDevApp(runtimeRoot, options.renderer);
    if (options.renderer === "upstream") await applyOriginalRendererRouterPatch({ stageRoot: appDir });
    console.log(`[sand] dev provider: ${options.provider}`);
    console.log(`[sand] dev box runtime: ${options.boxRuntime}`);
    console.log(`[sand] dev renderer: ${options.renderer}`);
    if (options.boxRuntime === "local-docker") console.log(`[sand] noVNC ports: ${environment.SAND_BOX_PRIMARY_NOVNC_PORT}/${environment.SAND_BOX_FORK_NOVNC_PORT}`);
    if (environment.VITE_DEV_SERVER_URL != null) console.log(`[sand] Vite: ${environment.VITE_DEV_SERVER_URL}`);
    console.log(`[sand] app dir: ${appDir}`);
    console.log(`[sand] user data: ${options.userDataDir}`);
    electron = spawnInherited(process.execPath, [electronCli, appDir, "--no-sandbox", "--disable-gpu", ...(options.remoteDebuggingPort == null ? [] : [`--remote-debugging-port=${options.remoteDebuggingPort}`]), `--user-data-dir=${options.userDataDir}`], environment);
    if (options.skipOnboarding) {
      try {
        await waitForHttp(`http://127.0.0.1:${options.controlPort}/gateway-offline`, 60_000);
        const response = await fetch(`http://127.0.0.1:${options.controlPort}/skip-onboarding`, { method: "POST" });
        if (response.ok) console.log("[sand] skipped onboarding for external provider development mode");
      } catch (error) {
        console.warn(`[sand] could not skip onboarding automatically: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const result = await childExit(electron);
    shutdown(result.code);
    if (result.error != null) throw result.error;
    return result.code;
  } catch (error) {
    shutdown(1);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseDevArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    try {
      process.exitCode = await runDev(options);
    } catch (error) {
      console.error(`[sand] dev startup failed: ${error instanceof Error ? error.message : String(error)}`);
      if (options.renderer === "source") {
        console.error("Source renderer development does not require the pinned DMG; check npm dependencies and the local Electron binary.");
      } else {
        console.error("Run `npm run bootstrap` only for the pinned upstream/fidelity renderer.");
      }
      process.exitCode = 1;
    }
  }
}
