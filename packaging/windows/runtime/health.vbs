Option Explicit

Dim shell, fso, powerShell, runtimeRoot, scriptPath, commandLine, exec, output, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
runtimeRoot = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(runtimeRoot, "bridge-health.ps1")
commandLine = Chr(34) & powerShell & Chr(34) & _
    " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
    Chr(34) & scriptPath & Chr(34)

Set exec = shell.Exec(commandLine)
output = exec.StdOut.ReadAll
exitCode = exec.ExitCode
If exitCode = 0 Then
    MsgBox output, vbInformation, "ChatGPT → QQ 完成通知：健康"
ElseIf InStr(1, output, "TARGET_CONFIGURED=NO", vbTextCompare) > 0 And _
    InStr(1, output, "QQ_GATEWAY=CONNECTED", vbTextCompare) > 0 Then
    MsgBox output & vbCrLf & "请给机器人发送一条 QQ 私聊消息以绑定完成通知目标。", vbInformation, "ChatGPT → QQ 完成通知：等待绑定"
Else
    MsgBox output & vbCrLf & "请先从桌面入口启动 ChatGPT；若仍失败，请运行“修复”。", vbExclamation, "ChatGPT → QQ 完成通知：需要处理"
End If
