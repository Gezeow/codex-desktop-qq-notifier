export const CODEX_DESKTOP_ATTACH_ONLY = "attach-only" as const;
export const CODEX_DESKTOP_MANAGED_APP_SERVER = "managed-app-server" as const;

export type CodexDesktopMode =
  | typeof CODEX_DESKTOP_ATTACH_ONLY
  | typeof CODEX_DESKTOP_MANAGED_APP_SERVER;

export function resolveCodexDesktopMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): CodexDesktopMode {
  const configured = env.CODEX_DESKTOP_MODE?.trim();
  if (configured === CODEX_DESKTOP_ATTACH_ONLY || configured === CODEX_DESKTOP_MANAGED_APP_SERVER) {
    return configured;
  }
  if (configured) {
    throw new Error(`Unsupported CODEX_DESKTOP_MODE: ${configured}`);
  }
  return platform === "win32"
    ? CODEX_DESKTOP_ATTACH_ONLY
    : CODEX_DESKTOP_MANAGED_APP_SERVER;
}

export function assertCodexCliSpawnAllowed(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): void {
  if (resolveCodexDesktopMode(env, platform) === CODEX_DESKTOP_ATTACH_ONLY) {
    throw new Error("CODEX_DESKTOP_ATTACH_ONLY_FORBIDS_CODEX_CLI");
  }
}

