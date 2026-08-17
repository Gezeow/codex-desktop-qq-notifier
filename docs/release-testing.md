# Release acceptance

## CI gates

Every pull request and release candidate must pass:

1. frozen install on Node.js 22.22.0;
2. TypeScript check, 238+ unit/contract/E2E tests, and build;
3. gitleaks over repository history and working tree;
4. Windows launcher/configuration tests under Windows PowerShell 5.1;
5. official Node checksum, Authenticode, version, and native SQLite ABI checks;
6. staged artifact denylist for credentials, personal paths, database, logs,
   runtime state, and probes;
7. generated dependency notices and non-empty CycloneDX SBOM;
8. Setup compilation, SHA-256 sidecar, manifest, and release verification.

## Clean Windows E2E

Run on a disposable Windows 11 x64 VM with no Node or developer tools:

1. install official Microsoft Store ChatGPT and sign in;
2. create a dedicated QQ Bot and note credentials outside the evidence bundle;
3. run Setup once and enter credentials;
4. send one QQ private message to establish the completion target;
5. open the community Desktop shortcut and run a read-only single-agent task;
6. confirm exactly one phone notification and one sent ledger row;
7. run a real read-only worker from the top-level Desktop task, wait for it, and
   confirm worker notification count `0`, main notification count `1`;
8. run a completion longer than one QQ part and verify ordered readable parts;
9. close ChatGPT and confirm bridge/watchdog cleanup;
10. run health, repair, and health again;
11. uninstall and confirm program/state/shortcuts are gone while official
    ChatGPT still launches and retains its Store registration.

Evidence must contain only timestamps, pass/fail markers, hashes, counts, and
redacted IDs. Do not archive credentials, OpenIDs, tokens, DBs, logs, screenshots
with account data, or personal filesystem paths.

The real phone-confirmed E2E is a release gate. Unit and mocked Windows tests do
not substitute for it.

