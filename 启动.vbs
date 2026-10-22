' 双击启动任务矩阵（不弹黑色命令行窗口）
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 0, False
