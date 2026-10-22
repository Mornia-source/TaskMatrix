// 读取任务栏上"应用按钮区"和"托盘区"的实际位置，算出中间可用的空白。
// 经典任务栏（StartAllBack / ExplorerPatcher 等）的应用按钮可通过 MSAA 读取，
// 读不到时返回 null，由调用方退回紧凑模式。所有坐标都是物理像素。
let koffi;
try { koffi = require('koffi'); } catch { koffi = null; }

let api = null;
function init() {
  if (api !== null) return api;
  api = false;
  if (!koffi || process.platform !== 'win32') return api;
  try {
    const RECT = koffi.struct('SPACE_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const GUID = koffi.struct('SPACE_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
    const VARIANT = koffi.struct('SPACE_VARIANT', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', val: 'int64', val2: 'int64' });

    const user32 = koffi.load('user32.dll');
    const oleacc = koffi.load('oleacc.dll');
    const ole32 = koffi.load('ole32.dll');
    const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, str16 cls, str16 name)');
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ SPACE_RECT *rect)');
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
    const AccessibleObjectFromWindow = oleacc.func('int32 __stdcall AccessibleObjectFromWindow(void *hwnd, uint32 id, SPACE_GUID *iid, _Out_ void **obj)');
    const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 flags)');
    CoInitializeEx(null, 0x2); // 单线程套间；已初始化时返回的错误码可以忽略

    // IAccessible 虚表下标：IUnknown(0-2) + IDispatch(3-6) 之后
    const Release = koffi.proto('uint32 __stdcall SpaceRelease(void *self)');
    const GetChildCount = koffi.proto('int32 __stdcall SpaceChildCount(void *self, _Out_ int32 *count)');
    const AccLocation = koffi.proto('int32 __stdcall SpaceAccLocation(void *self, _Out_ int32 *x, _Out_ int32 *y, _Out_ int32 *w, _Out_ int32 *h, SPACE_VARIANT child)');
    const IID_IAccessible = { d1: 0x618736E0, d2: 0x3C3D, d3: 0x11CF, d4: [0x81, 0x0C, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71] };
    const OBJID_CLIENT = 0xFFFFFFFC;
    const method = (obj, index, proto) => {
      const vtbl = koffi.decode(obj, 'void *');
      return koffi.decode(vtbl, index * 8, koffi.pointer(proto));
    };

    const rectOf = (hwnd) => {
      const r = {};
      return GetWindowRect(hwnd, r) ? r : null;
    };

    // 在子孙窗口里按类名找（任务栏窗口层级在不同任务栏实现里不一样）
    const findDeep = (parent, cls, depth = 0) => {
      const direct = FindWindowExW(parent, null, cls, null);
      if (direct) return direct;
      if (depth > 4) return null;
      let child = null;
      while ((child = FindWindowExW(parent, child, null, null))) {
        const hit = findDeep(child, cls, depth + 1);
        if (hit) return hit;
      }
      return null;
    };

    // 应用按钮：MSAA 子元素的位置
    const buttonRects = (hwnd) => {
      const out = [null];
      if (AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, IID_IAccessible, out) !== 0 || !out[0]) return null;
      const acc = out[0];
      try {
        const n = [0];
        koffi.call(method(acc, 8, GetChildCount), GetChildCount, acc, n);
        const loc = method(acc, 22, AccLocation);
        const rects = [];
        for (let i = 1; i <= n[0]; i++) {
          const x = [0], y = [0], w = [0], h = [0];
          const hr = koffi.call(loc, AccLocation, acc, x, y, w, h, { vt: 3, r1: 0, r2: 0, r3: 0, val: i, val2: 0 });
          if (hr === 0 && w[0] > 0 && h[0] > 0) rects.push({ left: x[0], top: y[0], right: x[0] + w[0], bottom: y[0] + h[0] });
        }
        return rects;
      } finally {
        koffi.call(method(acc, 2, Release), Release, acc);
      }
    };

    api = { findDeep, rectOf, buttonRects, IsWindowVisible };
  } catch (err) {
    console.warn('[taskbar-space] 初始化失败:', err.message);
    api = false;
  }
  return api;
}

// 返回 { bar, apps, appsEnd, tray, free }（物理像素），读不到返回 null
// free 是任务栏方向上可用的空白区间 [start, end]
function getTaskbarSpace() {
  const a = init();
  if (!a) return null;
  const tray = a.findDeep(null, 'Shell_TrayWnd', 99);
  if (!tray) return null;
  const bar = a.rectOf(tray);
  const list = a.findDeep(tray, 'MSTaskListWClass');
  const notify = a.findDeep(tray, 'TrayNotifyWnd');
  if (!bar || !list || !notify || !a.IsWindowVisible(list)) return null;

  const listRect = a.rectOf(list);
  const trayRect = a.rectOf(notify);
  const buttons = a.buttonRects(list);
  if (!listRect || !trayRect || !buttons) return null;

  const vertical = bar.bottom - bar.top > bar.right - bar.left;
  const appsEnd = buttons.length
    ? Math.max(...buttons.map((b) => (vertical ? b.bottom : b.right)))
    : (vertical ? listRect.top : listRect.left);
  const end = vertical ? Math.min(trayRect.top, listRect.bottom) : Math.min(trayRect.left, listRect.right);
  return { bar, vertical, appsEnd, trayStart: end, buttons: buttons.length, free: [appsEnd, end] };
}

module.exports = { getTaskbarSpace };
