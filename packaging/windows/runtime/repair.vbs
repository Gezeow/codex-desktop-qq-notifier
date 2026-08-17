Option Explicit

Dim shell, fso, installRoot, cachedSetup, commandLine
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
installRoot = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cachedSetup = fso.BuildPath(fso.BuildPath(installRoot, "repair"), "setup.exe")
If Not fso.FileExists(cachedSetup) Then
    MsgBox "修复安装程序不存在。请从 GitHub Releases 重新下载安装包。", vbCritical, "无法修复"
    WScript.Quit 1
End If
commandLine = Chr(34) & cachedSetup & Chr(34) & " /CURRENTUSER /NORESTART"
shell.Run commandLine, 1, False

