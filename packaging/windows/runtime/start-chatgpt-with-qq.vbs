Option Explicit

Dim shell, fso, powerShell, runtimeRoot, scriptPath, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
powerShell = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
runtimeRoot = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(runtimeRoot, "start-chatgpt-with-qq.ps1")
commandLine = Chr(34) & powerShell & Chr(34) & _
    " -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " & _
    Chr(34) & scriptPath & Chr(34)

shell.Run commandLine, 0, False
