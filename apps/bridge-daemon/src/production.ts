import { pathToFileURL } from "node:url";
import { loadConfigFromEnv } from "./config.js";
import { runBridgeDaemon } from "./main.js";
import {
  CODEX_DESKTOP_ATTACH_ONLY,
  resolveCodexDesktopMode
} from "../../../packages/adapters/codex-desktop/src/desktop-mode.js";

type FetchLike = typeof fetch;

type ProductionDeps = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchFn?: FetchLike;
  startBridge?: typeof runBridgeDaemon;
};

export async function runProductionBridge(deps: ProductionDeps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const config = loadConfigFromEnv(env);
  const mode = resolveCodexDesktopMode(env, platform);

  if (mode === CODEX_DESKTOP_ATTACH_ONLY) {
    const ready = await isExistingDesktopCdpReady(
      config.codexDesktop.remoteDebuggingPort,
      deps.fetchFn ?? fetch
    );
    if (!ready) {
      throw new Error("CODEX_DESKTOP_CDP_NOT_READY");
    }
    console.log("[qq-codex-bridge] codex desktop ready", {
      mode,
      launched: false,
      remoteDebuggingPort: config.codexDesktop.remoteDebuggingPort
    });
  }

  return (deps.startBridge ?? runBridgeDaemon)();
}

export async function isExistingDesktopCdpReady(port: number, fetchFn: FetchLike): Promise<boolean> {
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/json/version`);
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
    return typeof payload.webSocketDebuggerUrl === "string" && payload.webSocketDebuggerUrl.length > 0;
  } catch {
    return false;
  }
}

function handleFatal(error: unknown) {
  console.error("[qq-codex-bridge] fatal:", error instanceof Error ? error.message : String(error));
  if (error instanceof Error && error.stack) {
    console.error("  stack:", error.stack);
  }
  process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runProductionBridge().catch(handleFatal);
}

