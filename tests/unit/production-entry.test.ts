import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  runProductionBridge
} from "../../apps/bridge-daemon/src/production.js";

const validEnv: NodeJS.ProcessEnv = {
  QQBOT_APP_ID: "app-id",
  QQBOT_CLIENT_SECRET: "credential",
  CODEX_DESKTOP_MODE: "attach-only",
  CODEX_REMOTE_DEBUGGING_PORT: "9229"
};

describe("production attach-only entry", () => {
  it("reuses a ready existing Desktop and starts the bridge without launching another instance", async () => {
    const startBridge = vi.fn().mockResolvedValue({ channels: ["qqbot:default"] });
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:9229/devtools/browser/existing" })
    });

    await expect(runProductionBridge({
      env: validEnv,
      platform: "win32",
      fetchFn: fetchFn as typeof fetch,
      startBridge
    })).resolves.toEqual({ channels: ["qqbot:default"] });

    expect(fetchFn).toHaveBeenCalledWith("http://127.0.0.1:9229/json/version");
    expect(startBridge).toHaveBeenCalledTimes(1);
  });

  it("fails cleanly when CDP is missing and never starts the bridge", async () => {
    const startBridge = vi.fn();
    const fetchFn = vi.fn().mockRejectedValue(new Error("connect refused"));

    await expect(runProductionBridge({
      env: validEnv,
      platform: "win32",
      fetchFn: fetchFn as typeof fetch,
      startBridge
    })).rejects.toThrow("CODEX_DESKTOP_CDP_NOT_READY");
    expect(startBridge).toHaveBeenCalledTimes(0);
  });

  it("does not import the dev launcher path", () => {
    const source = fs.readFileSync(
      new URL("../../apps/bridge-daemon/src/production.ts", import.meta.url),
      "utf8"
    );
    expect(source).not.toContain("dev-launch");
    expect(source).not.toContain("ensureCodexDesktopForDev");
    expect(source).not.toContain("launchCodexDesktop");
  });
});

