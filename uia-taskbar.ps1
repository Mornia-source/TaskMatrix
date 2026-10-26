# 常驻的 UI Automation 辅助进程：每收到一行输入，就返回任务栏上所有按钮的屏幕矩形（物理像素）。
# 原版 Win11 任务栏是 XAML 绘制的，没有传统的 MSTaskListWClass 子窗口，只能通过 UI Automation 读取图标位置。
# 由 taskbar-uia.js 按需启动；输出一行 JSON：{"ok":true,"rects":[[left,top,right,bottom],...]}
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public class TbNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string n);
}
'@
# 必须声明 DPI 感知，否则缩放不是 100% 时拿到的是被虚拟化过的坐标
[void][TbNative]::SetProcessDPIAware()

$ae = [System.Windows.Automation.AutomationElement]
$types = 'Button', 'ListItem', 'SplitButton', 'MenuItem'
$conds = [System.Windows.Automation.Condition[]]@($types | ForEach-Object {
  New-Object System.Windows.Automation.PropertyCondition($ae::ControlTypeProperty, [System.Windows.Automation.ControlType]::$_)
})
$any = New-Object System.Windows.Automation.OrCondition($conds)

[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $h = [TbNative]::FindWindow('Shell_TrayWnd', $null)
    if ($h -eq [IntPtr]::Zero) { $out = '{"ok":false,"error":"no taskbar"}' }
    else {
      $root = $ae::FromHandle($h)
      $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $any)
      $parts = New-Object System.Collections.Generic.List[string]
      foreach ($e in $found) {
        $c = $e.Current
        if ($c.IsOffscreen) { continue }
        $r = $c.BoundingRectangle
        if ($r.IsEmpty -or $r.Width -le 0 -or $r.Height -le 0) { continue }
        $parts.Add(('[{0},{1},{2},{3}]' -f [int]$r.Left, [int]$r.Top, [int]$r.Right, [int]$r.Bottom))
      }
      $out = '{"ok":true,"rects":[' + ($parts -join ',') + ']}'
    }
  } catch {
    $msg = ($_.Exception.Message -replace '[^\x20-\x7e]', '?') -replace '"', "'"
    $out = '{"ok":false,"error":"' + $msg + '"}'
  }
  [Console]::Out.WriteLine($out)
  [Console]::Out.Flush()
}
