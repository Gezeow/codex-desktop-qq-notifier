Option Explicit

Dim shell, fso, expectedRoot, requestedRoot
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
expectedRoot = fso.GetAbsolutePathName(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\QqCodexCompletionNotifier"))
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
requestedRoot = fso.GetAbsolutePathName(WScript.Arguments(0))
If StrComp(expectedRoot, requestedRoot, vbTextCompare) <> 0 Then WScript.Quit 3

WScript.Sleep 10000
If fso.FolderExists(requestedRoot) Then
    fso.DeleteFolder requestedRoot, True
End If

