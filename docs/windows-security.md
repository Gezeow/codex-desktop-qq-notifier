# Windows security boundary

The Windows distribution is a per-user, on-demand notifier. It does not install
a service, scheduled task, Run-key entry, browser extension, or patched ChatGPT
binary.

## Trust boundaries

- The Microsoft Store package named `OpenAI.Codex` remains owned and updated by
  Microsoft Store/OpenAI. The launcher resolves its registered install location
  and starts `app\ChatGPT.exe`; it never writes below that package directory.
- CDP must have exactly one listener on `127.0.0.1:9229`. Any non-loopback or
  ambiguous listener stops startup.
- The bridge health listener binds to `127.0.0.1`. Health routes reject remote
  clients.
- QQ Bot credentials are accepted by the installer through a password field,
  moved through a protected temporary file, and stored with DPAPI CurrentUser.
  The configuration directory has protected inheritance and FullControl rules
  only for the current user and LocalSystem.
- Process shutdown validates the recorded Node entrypoint before stopping a PID.
  It does not force-kill unidentified processes.

## Data retained locally

`%LOCALAPPDATA%\QqCodexCompletionNotifier` contains encrypted credentials, a
SQLite dedupe/target ledger, bounded logs, and process state. Uninstall removes
this application-specific directory after the verified stop step.

No transcript database, QQ OpenID, access token, log, or process state is
included in source archives or release artifacts. Completion text is sent to
Tencent's QQ Bot API because that is the product's explicit function.

## Runtime provenance

The release job downloads Node.js `v22.22.0` from `nodejs.org`, checks the
official SHASUMS entry and pinned SHA-256, then verifies the embedded
`node.exe` Authenticode signer and certificate thumbprint. Inno Setup is fetched
from the immutable upstream GitHub release, verified with GitHub release
attestation and Authenticode before compilation.

The community installer itself requires an Authenticode certificate only for a
final signed release. CI preview artifacts may be unsigned and report that fact
explicitly; the final release gate can enable `-RequireSignature`.

