// 窗口 Z 序检测：任务栏本身也是置顶窗口，用户点一下开始菜单或任务栏图标，任务栏就会跳到我们的小组件上面把它盖住。
// 这里用 GetWindow(GW_HWNDPREV) 沿 Z 序向上数，看任务栏是否在小组件之上，是的话调用方立刻把小组件提回去。
let koffi;
try { koffi = require('koffi'); } catch { koffi = null; }

const GW_HWNDPREV = 3;
let api = null;
function init() {
  if (api !== null) return api;
  api = false;
  if (!koffi || process.platform !== 'win32') return api;
  try {
    const user32 = koffi.load('user32.dll');
    const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, str16 cls, str16 name)');
    const GetWindow = user32.func('void * __stdcall GetWindow(void *hwnd, uint32 cmd)');
    const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32 flags)');
    api = { FindWindowExW, GetWindow, SetWindowPos };
  } catch (err) {
    console.warn('[win-zorder] 初始化失败:', err.message);
  }
  return api;
}

// hwndBuffer：BrowserWindow.getNativeWindowHandle() 的返回值。任务栏在它上面返回 true
function taskbarAbove(hwndBuffer) {
  const a = init();
  if (!a) return false;
  try {
    const tray = a.FindWindowExW(null, null, 'Shell_TrayWnd', null);
    if (!tray) return false;
    const trayAddr = koffi.address(tray);
    let w = a.GetWindow(koffi.decode(hwndBuffer, 'void *'), GW_HWNDPREV);
    for (let i = 0; w && i < 400; i++) { // Z 序链很长时也要有上限
      if (koffi.address(w) === trayAddr) return true;
      w = a.GetWindow(w, GW_HWNDPREV);
    }
  } catch { /* 读不到就当没被盖住 */ }
  return false;
}

// 开发用：模拟"用户点了任务栏"——任务栏把自己提到置顶窗口的最上层（HWND_TOPMOST，不激活、不改位置大小）
function raiseTaskbar() {
  const a = init();
  const tray = a && a.FindWindowExW(null, null, 'Shell_TrayWnd', null);
  if (tray) a.SetWindowPos(tray, koffi.decode(Buffer.from('ffffffffffffffff', 'hex'), 'void *'), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
}

module.exports = { taskbarAbove, raiseTaskbar };
