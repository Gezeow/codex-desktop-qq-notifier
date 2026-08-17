#ifndef MyAppVersion
  #define MyAppVersion "0.2.0"
#endif
#ifndef SourceRoot
  #define SourceRoot "stage"
#endif
#ifndef OutputRoot
  #define OutputRoot "output"
#endif

[Setup]
AppId={{E721BD12-FA7F-45B8-913C-A9759DFA95BC}
AppName=ChatGPT to QQ Completion Notifier
AppVersion={#MyAppVersion}
AppPublisher=qq-codex-bridge contributors
AppPublisherURL=https://github.com/Gezeow/codex-desktop-qq-notifier
AppSupportURL=https://github.com/Gezeow/codex-desktop-qq-notifier/issues
AppUpdatesURL=https://github.com/Gezeow/codex-desktop-qq-notifier/releases
DefaultDirName={localappdata}\Programs\QqCodexCompletionNotifier
DefaultGroupName=ChatGPT to QQ Completion Notifier
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputRoot}
OutputBaseFilename=qq-codex-completion-notifier-{#MyAppVersion}-windows-x64-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern dynamic
UninstallDisplayName=ChatGPT to QQ Completion Notifier (Community)
SetupLogging=yes
CloseApplications=no
RestartApplications=no
RestartIfNeededByRun=no
UseSetupLdr=x64
RedirectionGuard=yes
LicenseFile=..\..\LICENSE
InfoBeforeFile=DISCLAIMER.txt

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs notimestamp

[Icons]
Name: "{autodesktop}\ChatGPT → QQ 完成通知（社区版）"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\start-chatgpt-with-qq.vbs"""; WorkingDir: "{app}"; Comment: "启动官方 ChatGPT Desktop 并发送 Codex 完成通知到 QQ"
Name: "{group}\启动 ChatGPT → QQ 完成通知"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\start-chatgpt-with-qq.vbs"""; WorkingDir: "{app}"
Name: "{group}\健康检查"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\health.vbs"""; WorkingDir: "{app}"
Name: "{group}\修复"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\repair.vbs"""; WorkingDir: "{app}"
Name: "{group}\卸载"; Filename: "{uninstallexe}"

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\runtime\stop-bridge.ps1"""; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "StopBridge"
Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\cleanup-after-uninstall.vbs"" ""{app}"""; Flags: runhidden nowait skipifdoesntexist; RunOnceId: "CleanupInstallRoot"

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\QqCodexCompletionNotifier"
Type: filesandordirs; Name: "{app}\repair"
Type: filesandordirs; Name: "{app}\runtime"

[Code]
var
  CredentialPage: TInputQueryWizardPage;

function PowerShellPath: String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function HasExistingCredentials: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\QqCodexCompletionNotifier\config\credentials.json'));
end;

function JsonEscape(Value: String): String;
begin
  Result := Value;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
  StringChangeEx(Result, #13, '\r', True);
  StringChangeEx(Result, #10, '\n', True);
end;

function RunConfigure(Arguments: String): Boolean;
var
  ExitCode: Integer;
begin
  Result := Exec(
    PowerShellPath,
    '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\runtime\configure.ps1') + '" ' + Arguments,
    '', SW_HIDE, ewWaitUntilTerminated, ExitCode
  ) and (ExitCode = 0);
end;

procedure InitializeWizard;
begin
  CredentialPage := CreateInputQueryPage(
    wpSelectDir,
    '腾讯 QQ Bot',
    '输入机器人凭证',
    '凭证只用于当前 Windows 用户，并通过 Windows DPAPI 加密保存。更新或修复时可留空以保留现有凭证。'
  );
  CredentialPage.Add('AppID:', False);
  CredentialPage.Add('AppSecret:', True);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  AppIdValue, AppSecretValue: String;
begin
  Result := True;
  if CurPageID <> CredentialPage.ID then
    exit;

  AppIdValue := Trim(CredentialPage.Values[0]);
  AppSecretValue := Trim(CredentialPage.Values[1]);
  if (AppIdValue = '') and (AppSecretValue = '') and HasExistingCredentials then
    exit;
  if (AppIdValue = '') or (AppSecretValue = '') then
  begin
    MsgBox('首次安装需要同时填写 QQ Bot AppID 和 AppSecret。', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  StopScript: String;
  ExitCode: Integer;
begin
  Result := '';
  StopScript := ExpandConstant('{app}\runtime\stop-bridge.ps1');
  if FileExists(StopScript) then
  begin
    if not Exec(
      PowerShellPath,
      '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + StopScript + '"',
      '', SW_HIDE, ewWaitUntilTerminated, ExitCode
    ) or (ExitCode <> 0) then
      Result := '无法安全停止现有通知进程。请运行健康检查后重试。';
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ConfigDir, PendingFile, Payload, RepairDir: String;
begin
  if CurStep <> ssPostInstall then
    exit;

  if (Trim(CredentialPage.Values[0]) <> '') or (Trim(CredentialPage.Values[1]) <> '') then
  begin
    ConfigDir := ExpandConstant('{localappdata}\QqCodexCompletionNotifier\config');
    PendingFile := AddBackslash(ConfigDir) + 'credentials.pending.json';
    if not RunConfigure('-InitializeOnly') then
      RaiseException('无法建立受保护的配置目录。');
    Payload := '{"appId":"' + JsonEscape(Trim(CredentialPage.Values[0])) +
      '","appSecret":"' + JsonEscape(Trim(CredentialPage.Values[1])) + '"}';
    if not SaveStringToFile(PendingFile, Payload, False) then
      RaiseException('无法写入临时配置。');
    if not RunConfigure('-PendingFile "' + PendingFile + '"') then
    begin
      DeleteFile(PendingFile);
      RaiseException('无法保护 QQ Bot 凭证。');
    end;
  end;

  RepairDir := ExpandConstant('{app}\repair');
  ForceDirectories(RepairDir);
  if not CopyFile(ExpandConstant('{srcexe}'), AddBackslash(RepairDir) + 'setup.exe', False) then
    Log('Warning: setup cache could not be created; repair requires the release installer.');
end;
