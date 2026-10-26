// 读取任务栏上"被占用的区间"（开始按钮、应用图标、托盘……），交给 taskbar-layout 找空白。所有坐标都是物理像素。
//
// 两条读取路径：
//   - 经典任务栏（StartAllBack / ExplorerPatcher 等）：每个应用按钮是 MSAA 子元素，位置精确、同步读取；
//   - 原版 Win11 任务栏（XAML 绘制，没有传统子窗口）：通过 UI Automation 辅助进程读取，异步更新、同步取缓存。
// 两条路都读不到时返回 null，调用方退回到"紧凑模式 + 手动拖动"。
const uia = require('./taskbar-uia');

let koffi;
try { koffi = require('koffi'); } catch { koffi = null; }

const CONTAINER_RATIO = 0.7; // 长度超过任务栏 70% 的元素是容器（比如 XAML 承载窗口），不算占用

let api = null;
function init() {
  if (api !== null) return api;
  api = false;
  if (!koffi || process.platform !== 'win32') return api;
  try {
    koffi.struct('SPACE_RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    const GUID = koffi.struct('SPACE_GUID', { d1: 'uint32', d2: 'uint16', d3: 'uint16', d4: koffi.array('uint8', 8) });
    void GUID;
    koffi.struct('SPACE_VARIANT', { vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', val: 'int64', val2: 'int64' });

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
      return GetWindowRect(hwnd, r) && r.right > r.left && r.bottom > r.top ? r : null;
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

    const children = (parent) => {
      const out = [];
      let child = null;
      while (out.length < 64 && (child = FindWindowExW(parent, child, null, null))) out.push(child);
      return out;
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

    api = { findDeep, children, rectOf, buttonRects, IsWindowVisible };
  } catch (err) {
    console.warn('[taskbar-space] 初始化失败:', err.message);
    api = false;
  }
  return api;
}

const sameRect = (a, b) => a.left === b.left && a.right === b.right && a.top === b.top && a.bottom === b.bottom;

// 返回 { bar, vertical, occupied: [[起, 止], ...], buttons, source }，读不到返回 null
//   bar：任务栏窗口的矩形（自动隐藏且收起时会在屏幕外）；occupied：沿任务栏长边方向的占用区间
function getTaskbarSpace() {
  const a = init();
  if (!a) return null;
  const tray = a.findDeep(null, 'Shell_TrayWnd', 99);
  if (!tray) return null;
  const bar = a.rectOf(tray);
  if (!bar) return null;

  const vertical = bar.bottom - bar.top > bar.right - bar.left;
  // 开发用：TM_FAKE_SPACE='[[0,48],[800,1128],[1500,1920]]' 伪造占用区间（物理像素），用来在真机上预览别的任务栏排布
  if (process.env.TM_FAKE_SPACE) return { bar, vertical, occupied: JSON.parse(process.env.TM_FAKE_SPACE), buttons: 0, source: 'fake' };
  const lo = (r) => (vertical ? r.top : r.left);
  const hi = (r) => (vertical ? r.bottom : r.right);
  const span = (r) => [lo(r), hi(r)];
  const barLen = hi(bar) - lo(bar);
  const inside = (r) => hi(r) > lo(bar) && lo(r) < hi(bar);
  const isContainer = (r) => hi(r) - lo(r) >= barLen * CONTAINER_RATIO;

  const list = a.findDeep(tray, 'MSTaskListWClass');
  const occupied = [];

  // TM_FORCE_UIA=1：开发用，在经典任务栏上也强制走 UI Automation 路径，用来测试辅助进程
  if (list && a.IsWindowVisible(list) && !process.env.TM_FORCE_UIA) {
    // 经典任务栏：直接子窗口（开始/搜索/任务视图按钮、托盘）+ 每个应用按钮
    const rebar = a.findDeep(tray, 'ReBarWindow32');
    const rebarRect = rebar && a.rectOf(rebar);
    for (const h of a.children(tray)) {
      if (!a.IsWindowVisible(h)) continue;
      const r = a.rectOf(h);
      if (!r || !inside(r) || isContainer(r) || (rebarRect && sameRect(r, rebarRect))) continue;
      occupied.push(span(r));
    }
    const buttons = a.buttonRects(list);
    if (!buttons) return null;
    for (const r of buttons) if (inside(r)) occupied.push(span(r));
    return { bar, vertical, occupied, buttons: buttons.length, source: 'msaa' };
  }

  // 原版 Win11 任务栏：UI Automation 读到的每个按钮（开始、搜索、应用图标、托盘图标、时钟……）
  const rects = uia.getRects();
  if (!rects) return null;
  for (const [left, top, right, bottom] of rects) {
    const r = { left, top, right, bottom };
    if (!inside(r) || isContainer(r)) continue;
    // 只要大部分在任务栏范围内（排除弹出菜单等漂在外面的元素）
    const cross = vertical ? [left, right, bar.left, bar.right] : [top, bottom, bar.top, bar.bottom];
    const overlap = Math.min(cross[1], cross[3]) - Math.max(cross[0], cross[2]);
    if (overlap < (cross[1] - cross[0]) * 0.5) continue;
    occupied.push(span(r));
  }
  if (!occupied.length) return null; // 一个按钮都没读到，不能当作"整条都是空白"
  return { bar, vertical, occupied, buttons: occupied.length, source: 'uia' };
}

module.exports = { getTaskbarSpace, setOnUpdate: uia.setOnUpdate, disposeUia: uia.dispose, uiaActive: uia.isActive };
