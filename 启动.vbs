' 双击启动任务矩阵（程序是图形界面，不会弹出黑色命令行窗口）
' 注意：Run 的第二个参数必须是 1（正常显示）。如果写成 0（隐藏），Windows 会把程序里第一次显示窗口的操作改成隐藏，
' 启动时自动弹出的面板就显示不出来，还会在屏幕上留下一块灰色残影。
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\node_modules\electron\dist\electron.exe"" """ & dir & """", 1, False
