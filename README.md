# ChatGPT Desktop → QQ 完成通知（Windows 社区版）

当 Windows 版 ChatGPT Desktop 中的 Codex 任务完成时，通过腾讯 QQ Bot
把最终结果发送到你的 QQ 私聊。支持单任务与 multi-agent 顶层任务
exactly-one 通知、长结果分段、断线重试、重启后去重，以及关闭 ChatGPT 后
自动停止本地桥接进程。

这是独立社区项目，不隶属于 OpenAI 或腾讯，也不捆绑、替代或修改
Microsoft Store 的 ChatGPT。上游项目与本 changeset 均采用 MIT 许可证，
详见 [LICENSE](LICENSE) 和 [NOTICE.md](NOTICE.md)。

## 你需要准备

- Windows 10/11 x64；
- 已从 Microsoft Store 安装并登录 ChatGPT Desktop；
- 一个腾讯 QQ Bot 的 `AppID` 和 `AppSecret`。

普通用户不需要安装 Node.js、pnpm、PowerShell 模块，也不需要理解 CDP 或代码。
安装包自带经官方 SHA-256 与 Authenticode 校验的 Node.js 22.22.0 x64 运行时。

## 安装

1. 打开 [QQ 开放平台](https://q.qq.com/qqbot/openclaw/index.html)，创建机器人，
   在机器人详情页取得 `AppID` 和 `AppSecret`。
2. 从本项目 GitHub Releases 下载：
   `qq-codex-completion-notifier-<version>-windows-x64-setup.exe` 及同名
   `.sha256` 文件。
3. 可选但推荐：在 PowerShell 中校验下载文件：

   ```powershell
   Get-FileHash .\qq-codex-completion-notifier-*-setup.exe -Algorithm SHA256
   ```

4. 运行安装程序，输入一次 `AppID` 和 `AppSecret`。
5. 以后只使用桌面的“ChatGPT → QQ 完成通知（社区版）”入口。

首次启动会打开官方 ChatGPT Desktop，并在仅回环地址 `127.0.0.1:9229`
启用调试端口；QQ 网关与完成监控全部健康后，入口即准备就绪。重复点击会复用
同一个 ChatGPT、桥接进程和 watchdog，不会创建重复实例。

凭证由 Windows DPAPI 按当前用户加密，保存在
`%LOCALAPPDATA%\QqCodexCompletionNotifier\config`。凭证不会写入命令行、日志、
数据库或发行包。

## 使用

在通过社区入口打开的 ChatGPT Desktop 中正常运行 Codex。任务从 running 变为稳定
completed 后，桥接器只为顶层 Desktop 任务创建一条 exactly-once ledger 记录，
随后发送到安装时绑定的 QQ 私聊。长结果按可读边界分段，并保持 Markdown 代码围栏。

第一次绑定目标 QQ 时，请先给机器人发送一条普通消息。桥接器只用这条入站事件确定
你的 QQ 私聊 OpenID；之后 Desktop 完成通知使用 QQ C2C 主动消息接口发送。

## 健康检查、修复和卸载

开始菜单的项目文件夹提供三个入口：

- “健康检查”：显示 ChatGPT/CDP、QQ 网关、完成监控、目标绑定和实例数；
- “修复”：重新运行本机缓存的同版本安装程序，可更新凭证并恢复缺失文件；
- “卸载”：先按已记录的进程身份安全停止桥接器，再删除程序、快捷方式、
  DPAPI 凭证、数据库、状态与日志。

卸载不会删除、重装或修改 Microsoft Store ChatGPT，也不会终止无法证明身份的进程。

## V1 能力与非目标

V1 保证的发行面：

- Windows x64 ON-DEMAND 启动，无常驻终端、无登录自启动；
- 关闭被监控的 ChatGPT 主进程后自动清理桥接器；
- Desktop 顶层 single/multi-agent exactly-one 完成通知；
- QQ C2C 主动文本发送、长消息分段、有限重试和持久去重；
- 回环限定 CDP、本地健康端点、日志脱敏与有界轮转；
- 一键安装、修复、健康检查和完整卸载。

V1 不承诺 QQ → Codex composer 控制。上游仓库仍可能包含实验性双向桥接代码，
但 Windows 发行入口强制 `attach-only`，禁止启动 Codex CLI/app-server，也不会把
composer 行为描述为受支持功能。

## 安全与隐私

- CDP 只允许 `127.0.0.1`；发现非回环或多个监听器时 fail closed；
- HTTP 健康端点只允许本机请求；
- AppSecret 通过 DPAPI CurrentUser 保护；标识符在日志中只保留短哈希；
- 完成文本发送前会移除常见 token、Authorization、AppSecret 模式；
- 发布流水线检查 secret、个人路径、SQLite、日志和运行状态文件；
- Node.js 固定到官方 `v22.22.0`，Windows x64 ZIP SHA-256 为
  `c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a`。

完整威胁边界见 [docs/windows-security.md](docs/windows-security.md)。

## 从源码验证

开发者需要 Node.js 22.22.0 与 pnpm。不要使用 Node 24 运行原生 SQLite 测试。

```powershell
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
powershell.exe -NoProfile -File packaging/windows/build-stage.ps1
```

发行架构、CI 门和真实 E2E 清单见
[docs/windows-release.md](docs/windows-release.md) 与
[docs/release-testing.md](docs/release-testing.md)。

## 许可证

MIT。发行包同时包含 `THIRD_PARTY_NOTICES.md` 和 CycloneDX SBOM。
