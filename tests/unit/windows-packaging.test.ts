import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packagingRoot = path.join(repoRoot, "packaging", "windows");
const runtimeRoot = path.join(packagingRoot, "runtime");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("public Windows packaging", () => {
  it("keeps every runtime script portable and out of Windows autostart", () => {
    const runtimeFiles = fs.readdirSync(runtimeRoot)
      .filter((name) => /\.(?:ps1|vbs)$/i.test(name))
      .map((name) => fs.readFileSync(path.join(runtimeRoot, name), "utf8"));
    const source = runtimeFiles.join("\n");

    expect(source).not.toMatch(/[A-Za-z]:\\(?:AI|Users)\\/i);
    expect(source).not.toMatch(/Register-ScheduledTask|New-ScheduledTask|CurrentVersion\\Run|Startup\\/i);
    expect(source).not.toContain("GetEnvironmentVariable($Name, 'User')");
    expect(source).toContain("CODEX_DESKTOP_MODE = 'attach-only'");
    expect(source).toContain("READY_TARGET_PENDING");
    expect(source).toContain("OpenAI.Codex");
    expect(source).toContain("127.0.0.1");
  });

  it("protects credentials with DPAPI and a private current-user directory", () => {
    const configure = read("packaging/windows/runtime/configure.ps1");
    const bridge = read("packaging/windows/runtime/start-bridge.ps1");
    const installer = read("packaging/windows/installer.iss");

    expect(configure).toContain("DataProtectionScope]::CurrentUser");
    expect(configure).toContain("SetAccessRuleProtection($true, $false)");
    expect(configure).toContain("credentials.pending.json");
    expect(bridge).toContain("ProtectedData]::Unprotect");
    expect(bridge).toContain("QQ_CODEX_DATABASE_PATH = Join-Path $databaseRoot");
    expect(bridge).not.toMatch(/Write-(?:Output|Host|Warning|Error).*appSecret/i);
    expect(installer).toContain("CredentialPage.Add('AppSecret:', True)");
    expect(installer).not.toMatch(/AppSecret=.*\{/i);
  });

  it("installs per user, repairs from a cache, and removes only notifier-owned state", () => {
    const installer = read("packaging/windows/installer.iss");
    const repair = read("packaging/windows/runtime/repair.vbs");
    const stop = read("packaging/windows/runtime/stop-bridge.ps1");

    expect(installer).toContain("PrivilegesRequired=lowest");
    expect(installer).toContain("{localappdata}\\Programs\\QqCodexCompletionNotifier");
    expect(installer).toContain("{localappdata}\\QqCodexCompletionNotifier");
    expect(installer).toContain("Type: filesandordirs; Name: \"{app}\\repair\"");
    expect(installer).toContain("cleanup-after-uninstall.vbs");
    expect(repair).toContain("repair");
    expect(stop).toContain("Refusing to stop it");
    expect(installer).not.toMatch(/Remove-AppxPackage|Reset-AppxPackage|Add-AppxPackage/i);
  });

  it("pins and verifies the official Node x64 runtime", () => {
    const build = read("packaging/windows/build-stage.ps1");
    expect(build).toContain("https://nodejs.org/dist/$nodeVersion/$nodeArchiveName");
    expect(build).toContain("c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a");
    expect(build).toContain("8FDE473B4E037DBCD4BFC8C8042B0246E46E560A");
    expect(build).toContain("Get-AuthenticodeSignature");
    expect(build).toContain("BETTER_SQLITE3_ABI=READY");
  });

  it("defines CI test, secret-scan, SBOM and artifact verification gates", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("node-version: 22.22.0");
    expect(ci).toContain("pnpm install --frozen-lockfile");
    expect(ci).toContain("gitleaks/gitleaks-action@dcedce43c6f43de0b836d1fe38946645c9c638dc");
    expect(ci).toContain("build-stage.ps1");
    expect(ci).toContain("build-installer.ps1");
    expect(ci).toContain("SBOM.cdx.json");
  });

  it.skipIf(process.platform !== "win32")("parses all PowerShell runtime files under Windows PowerShell 5.1", () => {
    const powershell = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    for (const name of fs.readdirSync(runtimeRoot).filter((value) => value.endsWith(".ps1"))) {
      const script = path.join(runtimeRoot, name).replace(/'/g, "''");
      const result = spawnSync(powershell, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$errors=$null; [Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$errors) | Out-Null; if($errors.Count){$errors | Out-String | Write-Error; exit 1}`
      ], { encoding: "utf8" });
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });
});
