// 获取任务栏真实位置。
// 优先用 Windows AppBar 接口（StartAllBack 等改过位置的任务栏也能正确报告，且自动隐藏时依然有效），
// 拿不到时退回到"屏幕区域 - 工作区"的差值推断，再不行就当作在底部。
const { screen } = require('electron');

const EDGES = ['left', 'top', 'right', 'bottom'];
const ABM_GETSTATE = 4;
const ABM_GETTASKBARPOS = 5;
const ABS_AUTOHIDE = 1;

let appBar = null;
let notifyState = null;
try {
  const koffi = require('koffi');
  const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const APPBARDATA = koffi.struct('APPBARDATA', {
    cbSize: 'uint32', hWnd: 'void *', uCallbackMessage: 'uint32', uEdge: 'uint32', rc: RECT, lParam: 'intptr',
  });
  const shell32 = koffi.load('shell32.dll');
  const SHAppBarMessage = shell32.func('uintptr __stdcall SHAppBarMessage(uint32 msg, _Inout_ APPBARDATA *data)');
  const size = koffi.sizeof(APPBARDATA);
  const blank = () => ({ cbSize: size, hWnd: null, uCallbackMessage: 0, uEdge: 0, rc: { left: 0, top: 0, right: 0, bottom: 0 }, lParam: 0 });

  appBar = () => {
    const d = blank();
    if (!SHAppBarMessage(ABM_GETTASKBARPOS, d)) return null;
    const { left, top, right, bottom } = d.rc;
    if (right <= left || bottom <= top) return null;
    const rect = screen.screenToDipRect(null, { x: left, y: top, width: right - left, height: bottom - top });
    const autoHide = (Number(SHAppBarMessage(ABM_GETSTATE, blank())) & ABS_AUTOHIDE) !== 0;
    return { edge: EDGES[d.uEdge] || 'bottom', rect, autoHide };
  };

  // 系统"免打扰"状态：2=全屏程序 3=D3D 全屏游戏 4=演示模式
  const SHQueryUserNotificationState = shell32.func('int32 __stdcall SHQueryUserNotificationState(_Out_ int32 *state)');
  notifyState = () => {
    const out = [0];
    return SHQueryUserNotificationState(out) === 0 ? out[0] : 0;
  };
} catch (err) {
  console.warn('[taskbar] AppBar 接口不可用，改用工作区推断:', err.message);
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// 返回指定显示器上任务栏的 { edge, thickness, rect, autoHide, source }
function getTaskbar(display) {
  const { bounds: b, workArea: w } = display;

  // 1. AppBar 接口（只报告主任务栏，所以要确认它在这块屏上）
  const ab = appBar && appBar();
  if (ab && overlaps(ab.rect, b)) {
    const thickness = ab.edge === 'left' || ab.edge === 'right' ? ab.rect.width : ab.rect.height;
    return { ...ab, thickness, source: 'appbar' };
  }

  // 2. 工作区差值：哪一边被让出来了，任务栏就在哪
  const gaps = {
    top: w.y - b.y,
    bottom: b.y + b.height - (w.y + w.height),
    left: w.x - b.x,
    right: b.x + b.width - (w.x + w.width),
  };
  const [edge, thickness] = Object.entries(gaps).sort((x, y) => y[1] - x[1])[0];
  if (thickness > 0) {
    const rect = {
      top: { x: b.x, y: b.y, width: b.width, height: thickness },
      bottom: { x: b.x, y: b.y + b.height - thickness, width: b.width, height: thickness },
      left: { x: b.x, y: b.y, width: thickness, height: b.height },
      right: { x: b.x + b.width - thickness, y: b.y, width: thickness, height: b.height },
    }[edge];
    return { edge, thickness, rect, autoHide: false, source: 'workarea' };
  }

  // 3. 副屏且自动隐藏：沿用主任务栏的停靠边
  const edgeGuess = ab ? ab.edge : 'bottom';
  const t = ab ? (ab.edge === 'left' || ab.edge === 'right' ? ab.rect.width : ab.rect.height) : 48;
  return { edge: edgeGuess, thickness: t, rect: null, autoHide: true, source: 'guess' };
}

// 计算面板应放的位置：贴着任务栏、尽量对准托盘图标
function placeNear(display, size, trayBounds, margin = 8) {
  const tb = getTaskbar(display);
  const { bounds: b } = display;
  const { width: W, height: H } = size;
  // 自动隐藏时任务栏弹出会盖住面板，所以按任务栏厚度留出位置
  const inset = tb.thickness + margin;

  // 托盘图标确实在任务栏上（不在"隐藏的图标"弹出框里）时，沿任务栏方向对准它
  const trayOnBar = trayBounds && tb.rect && overlaps(trayBounds, tb.rect);
  const cx = trayOnBar ? trayBounds.x + trayBounds.width / 2 : null;
  const cy = trayOnBar ? trayBounds.y + trayBounds.height / 2 : null;

  let x, y;
  if (tb.edge === 'top' || tb.edge === 'bottom') {
    x = cx != null ? cx - W / 2 : b.x + b.width - W - margin;
    y = tb.edge === 'top' ? b.y + inset : b.y + b.height - inset - H;
  } else {
    y = cy != null ? cy - H / 2 : b.y + b.height - H - margin;
    x = tb.edge === 'left' ? b.x + inset : b.x + b.width - inset - W;
  }

  // 限制在屏幕内，并且不压到任务栏
  const minX = b.x + margin + (tb.edge === 'left' ? tb.thickness : 0);
  const maxX = b.x + b.width - margin - W - (tb.edge === 'right' ? tb.thickness : 0);
  const minY = b.y + margin + (tb.edge === 'top' ? tb.thickness : 0);
  const maxY = b.y + b.height - margin - H - (tb.edge === 'bottom' ? tb.thickness : 0);
  x = Math.min(Math.max(x, minX), maxX);
  y = Math.min(Math.max(y, minY), maxY);

  return { x: Math.round(x), y: Math.round(y), edge: tb.edge, taskbar: tb };
}

const isFullscreenBusy = () => !!notifyState && [2, 3, 4].includes(notifyState());

module.exports = { getTaskbar, placeNear, isFullscreenBusy };
