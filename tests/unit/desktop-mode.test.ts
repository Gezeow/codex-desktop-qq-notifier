import { describe, expect, it, vi } from "vitest";
import {
  assertCodexCliSpawnAllowed,
  CODEX_DESKTOP_ATTACH_ONLY,
  CODEX_DESKTOP_MANAGED_APP_SERVER,
  resolveCodexDesktopMode
} from "../../packages/adapters/codex-desktop/src/desktop-mode.js";
import { spawnManagedCodexAppServer } from "../../packages/adapters/codex-desktop/src/codex-app-server-driver.js";

describe("Codex desktop mode", () => {
  it("defaults Windows to attach-only without changing non-Windows managed behavior", () => {
    expect(resolveCodexDesktopMode({}, "win32")).toBe(CODEX_DESKTOP_ATTACH_ONLY);
    expect(resolveCodexDesktopMode({}, "darwin")).toBe(CODEX_DESKTOP_MANAGED_APP_SERVER);
  });

  it("hard-blocks every Codex CLI spawn attempt in attach-only mode", () => {
    const spawnFn = vi.fn();

    expect(() =>
      spawnManagedCodexAppServer("codex", ["app-server"], {}, {
        env: { CODEX_DESKTOP_MODE: "attach-only" },
        platform: "win32",
        spawnFn
      })
    ).toThrow("CODEX_DESKTOP_ATTACH_ONLY_FORBIDS_CODEX_CLI");
    expect(spawnFn).toHaveBeenCalledTimes(0);
    expect(() => assertCodexCliSpawnAllowed({}, "win32")).toThrow(
      "CODEX_DESKTOP_ATTACH_ONLY_FORBIDS_CODEX_CLI"
    );
  });

  it("keeps the upstream managed app-server mode available outside attach-only", () => {
    expect(() =>
      assertCodexCliSpawnAllowed(
        { CODEX_DESKTOP_MODE: "managed-app-server" },
        "darwin"
      )
    ).not.toThrow();
  });
});

