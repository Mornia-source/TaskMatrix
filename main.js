const { app, BrowserWindow, Tray, ipcMain, globalShortcut, nativeImage, screen, powerMonitor, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { placeNear, getTaskbar, isFullscreenBusy } = require('./taskbar');
const { getTaskbarSpace, setOnUpdate: onTaskbarUiaUpdate, disposeUia, uiaActive } = require('./taskbar-space');
const { pickSlot, visibleRatio, COMPACT_W } = require('./taskbar-layout');
const { taskbarAbove } = require('./win-zorder');

process.on('unhandledRejection', (err) => console.error('[main] unhandled:', err));
// Chromium 的"窗口遮挡检测"会把被盖住/刚隐藏的窗口判成不可见而暂停绘制，再显示时偶发黑块；
// 小组件叠在任务栏上也会因此偶发闪烁。托盘类应用关掉它（TM_BASELINE=1 时保留，用于对比测试）
if (!process.env.TM_BASELINE) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// 开发用：把数据目录指到别处，测试时不碰真实任务
if (process.env.TM_USERDATA) app.setPath('userData', process.env.TM_USERDATA);

const WIN_W = 440;
const WIN_H = 680;
const HOTKEY = 'Alt+Shift+Q';
const MENU_W = 248;
const DEFAULT_SETTINGS = {
  theme: 'steel', skin: 'minimal', sound: true,
  radius: 12,                 // 极简皮肤的圆角（px），0 = 直角
  widget: true,               // 在任务栏上显示小组件
  widgetExpand: true,         // 空间够时直接显示任务卡片
  widgetRotate: false,        // 自动轮换任务栏上显示的任务（默认关）
  widgetRotateSec: 8,         // 轮换间隔（秒）
  widgetPlace: 'auto',        // 放在哪块空白：auto 自动 / left 靠左 / right 靠右（居中的任务栏左右各有一块）
  widgetGap: 8,               // 和图标、托盘之间留的间距（px）
  widgetMaxWidth: 760,        // 小组件最宽多少（px）
  widgetCollapse: 'badge',    // 空间不足时：badge 折叠成徽标 / hide 隐藏
  widgetAutoHide: 'follow',   // 任务栏自动隐藏时：follow 跟随任务栏弹出 / hide 不显示
  widgetOffset: 0.66,         // 读不到图标位置时（竖向任务栏等）用户拖动出的位置
};
const ENUMS = { widgetPlace: ['auto', 'left', 'right'], widgetCollapse: ['badge', 'hide'], widgetAutoHide: ['follow', 'hide'] };
const RANGES = { radius: [0, 20], widgetGap: [0, 24], widgetMaxWidth: [320, 1200], widgetOffset: [0, 1], widgetRotateSec: [3, 120] };
// data.settings 只保存用户明确改过的项，其余用默认值。这样以后改默认值才会对老用户生效。
// settingsVersion 2：旧版本把默认值整份写进了数据文件，升级时清掉旧的皮肤记录（默认皮肤改成了极简）
const SETTINGS_VERSION = 2;

let win = null;      // 主面板
let widget = null;   // 任务栏小组件
let menu = null;     // 自绘右键菜单
let tray = null;
let pinned = false;
let isQuitting = false;
let data = null;     // 主进程持有的唯一数据副本

const page = (name) => path.join(__dirname, 'renderer', name);
const dataFile = () => path.join(app.getPath('userData'), 'data.json');
const settings = () => ({ ...DEFAULT_SETTINGS, ...(data && data.settings) });

// 面板事件调试（TM_DEBUG_PANEL=1）：显示 / 隐藏 / 焦点 / 画出来的耗时，用来复现"面板偶发黑块"
const pdbg = (...a) => { if (process.env.TM_DEBUG_PANEL) console.log('[panel ' + new Date().toISOString().slice(11, 23) + ']', ...a); };

// 异常现象的诊断日志（userData/debug.log）：只记录"面板没画出来"这类少见情况，下次出问题时有据可查
function dlog(msg) {
  console.log('[dlog]', msg);
  try {
    const f = path.join(app.getPath('userData'), 'debug.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 100 * 1024) fs.writeFileSync(f, '');
    fs.appendFileSync(f, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 日志写不了不影响使用 */ }
}

// 保存一份诊断快照（见 diagnose.js）。自动触发的同一时段只存一次，免得反复出问题时刷屏；手动触发不限制
const diagnose = require('./diagnose');
let lastDiagAt = 0;
async function dumpDiagnostics(reason, force = false) {
  if (!force && Date.now() - lastDiagAt < 30000) return null;
  lastDiagAt = Date.now();
  try {
    const text = await diagnose.collect({ win, widget, menu, panelReady: () => panelReady, showSeq: () => showSeq, shownAck: () => shownAck }, reason);
    const f = diagnose.save(text);
    dlog(`已保存诊断快照（${reason}）`);
    return f;
  } catch (err) {
    dlog('保存诊断快照失败：' + err.message);
    return null;
  }
}

// 窗口里的页面（渲染进程）崩溃或长时间无响应时自动恢复。
// 任务栏上的点击是由这些页面处理的：小组件的页面一旦挂掉，点击没反应、显示也不再更新，用户只会觉得"软件坏了"
function watchRenderer(name, w) {
  let hangTimer = null;
  const reload = () => { if (!w.isDestroyed()) w.webContents.reload(); };
  w.webContents.on('render-process-gone', (_e, d) => {
    if (isQuitting || d.reason === 'clean-exit') return; // 程序正常退出时子进程也会"退出"，那不是异常
    dlog(`${name}页面的渲染进程退出：${d.reason}（${d.exitCode}），重新载入`);
    dumpDiagnostics(`${name}渲染进程退出：${d.reason}`);
    if (!process.env.TM_NO_WATCH) setTimeout(reload, 500); // TM_NO_WATCH：测试时保留崩溃后的原样
  });
  w.on('unresponsive', () => {
    dlog(`${name}页面无响应`);
    dumpDiagnostics(`${name}页面无响应`);
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => { dlog(`${name}页面持续无响应，重新载入`); reload(); }, 8000);
  });
  w.on('responsive', () => { clearTimeout(hangTimer); dlog(`${name}页面恢复响应`); });
}

// ---------- 数据 ----------
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
  } catch {
    return null;
  }
}

function saveData() {
  // 先写临时文件再改名，避免写一半崩溃导致数据损坏
  const file = dataFile();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function send(target, channel, payload) {
  if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
}

function broadcast(channel, payload, except) {
  for (const w of [win, widget, menu]) if (w && w.webContents !== except) send(w, channel, payload);
}

function openCounts() {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const t of (data && data.tasks) || []) if (!t.done) c[t.q]++;
  return c;
}

// 来自渲染进程的设置不能直接信：只收已知的键，数值夹到合法范围，枚举只收合法值
function sanitizeSettings(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (ENUMS[k]) { if (ENUMS[k].includes(v)) out[k] = v; continue; }
    if (RANGES[k]) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = Math.min(RANGES[k][1], Math.max(RANGES[k][0], k === 'widgetOffset' ? n : Math.round(n)));
      continue;
    }
    if (typeof v === typeof DEFAULT_SETTINGS[k]) out[k] = v;
  }
  return out;
}

function updateSettings(patch) {
  patch = sanitizeSettings(patch);
  data ||= { version: 1, settingsVersion: SETTINGS_VERSION, tasks: [], stats: { xp: 0, daily: {} } };
  data.settings = { ...(data.settings || {}), ...patch };
  saveData();
  broadcast('settings-changed', settings());
  applyWidgetVisibility();
}

// 升级旧数据文件里的设置
function migrateSettings() {
  if (!data || (data.settingsVersion || 1) >= SETTINGS_VERSION) return;
  if (data.settings) delete data.settings.skin;
  data.settingsVersion = SETTINGS_VERSION;
  saveData();
}

// ---------- 托盘图标：四象限，有任务的格子点亮 ----------
const Q_COLORS = [[255, 77, 61], [255, 176, 32], [42, 212, 255], [140, 150, 160]];

function makeTrayIcon(counts) {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inGap = x < 2 || y < 2 || x > 29 || y > 29 || (x >= 15 && x <= 16) || (y >= 15 && y <= 16);
      if (inGap) continue;
      const q = (y > 16 ? 2 : 0) + (x > 16 ? 1 : 0);
      const lit = !counts || counts[q + 1] > 0;
      const edge = x === 2 || y === 2 || x === 29 || y === 29 || x === 14 || x === 17 || y === 14 || y === 17;
      const [r, g, b] = Q_COLORS[q];
      const k = lit ? 1 : 0.28;
      const i = (y * size + x) * 4;
      buf[i] = b * k; buf[i + 1] = g * k; buf[i + 2] = r * k;
      buf[i + 3] = lit || edge ? 255 : 150; // BGRA；空象限只留暗色描边
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function refreshTray() {
  if (!tray) return;
  const c = openCounts();
  tray.setImage(makeTrayIcon(c));
  const today = (data && data.stats && data.stats.daily[dayKey()]) || 0;
  tray.setToolTip(`任务矩阵  Q1 ${c[1]} · Q2 ${c[2]} · Q3 ${c[3]} · Q4 ${c[4]}\n今日完成 ${today}`);
}

function dayKey(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- 主面板 ----------
// 贴着任务栏摆放（上/下/左/右都适配，含 StartAllBack 等第三方任务栏）
let lastEdge = 'bottom';
function positionWindow(anchor) {
  const point = anchor ? { x: anchor.x, y: anchor.y } : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);

  // 小屏幕上窗口太高时自动缩短
  const [w, h] = win.getSize();
  const room = display.workArea.height - 16;
  const size = { width: w, height: Math.min(h, Math.max(room, 520)) };
  if (size.height !== h) win.setSize(size.width, size.height);

  const pos = placeNear(display, size, anchor);
  win.setPosition(pos.x, pos.y);
  lastEdge = pos.edge;
}

// anchor：从托盘或小组件打开时传入它的矩形，面板会对准它
let showSeq = 0, shownAck = 0;
const showAt = new Map(), ackLatency = []; // 显示 → 页面回报画出来了 的耗时（毫秒），压测时统计用
function showWindow(anchor = null, focusInput = false) {
  if (!win) return;
  positionWindow(anchor);
  win.show();
  // 程序被以"隐藏 / 最小化"的方式启动时（比如启动脚本里 Run 的第二个参数是 0），Windows 会把进程里第一次 ShowWindow 改成隐藏 / 最小化：
  // 面板其实没显示出来，屏幕上还会留下一块 #202020 的灰色残影（有圆角和阴影，但没有窗口，截图工具也认不到）。
  // 第一次被吞掉之后，再显示一次就正常了
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) { dlog('面板第一次显示被系统吞掉（启动方式是隐藏 / 最小化），重新显示'); win.show(); }
  win.focus();
  win.webContents.invalidate(); // 显示时强制重绘一帧
  const token = ++showSeq;
  showAt.set(token, Date.now());
  pdbg('显示', token, '可见', win.isVisible(), '有焦点', win.isFocused(), '已就绪', panelReady);
  send(win, 'window-shown', { edge: lastEdge, focusInput, token });
  watchPanelPaint(token);
}

// 面板显示后页面要在下一帧回报"画出来了"。600ms 没收到说明画面没出来（显示成黑块）：
// 先强制重绘一次，还不行就重新载入页面（数据在主进程里，不会丢）
let panelReady = false; // 页面脚本已经初始化完（注册好了监听）；没就绪时收不到"已显示"消息，不能当成黑屏
function watchPanelPaint(token) {
  if (!panelReady) return;
  const stale = () => token !== showSeq || shownAck >= token || !win.isVisible() || !panelReady;
  setTimeout(() => {
    if (stale()) return;
    dlog('面板显示后没有收到绘制确认，强制重绘');
    dumpDiagnostics('面板显示后 600ms 没有画出来'); // 趁现场还在，记下页面、GPU、显示器的真实状态
    win.webContents.invalidate();
    setTimeout(() => {
      if (stale()) return;
      dlog('强制重绘无效，重新载入面板页面');
      win.webContents.reload();
    }, 1200);
  }, 600);
}
ipcMain.on('panel:ready', () => { panelReady = true; });
ipcMain.on('win:shown-ack', (_e, token) => {
  shownAck = Math.max(shownAck, Number(token) || 0);
  if (showAt.has(token)) { ackLatency.push(Date.now() - showAt.get(token)); pdbg('画出来了', token, ackLatency[ackLatency.length - 1] + 'ms'); showAt.delete(token); }
});

// 点托盘/小组件时面板会先因失焦被隐藏，紧接着又收到点击；这种情况当作"关闭"
let lastBlurHide = 0;
function toggleWindow(anchor = null) {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) win.hide();
  else if (anchor && Date.now() - lastBlurHide < 300) return;
  else showWindow(anchor);
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    minWidth: 380,
    minHeight: 520,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: '#1a1c1f',
    // 面板隐藏时也要能处理小组件发来的"完成任务"等操作，不能被后台节流
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.loadFile(page('index.html'));
  win.webContents.on('did-start-loading', () => { panelReady = false; }); // 重新载入时重置，等页面再次报告就绪

  for (const ev of ['show', 'hide', 'focus', 'blur', 'minimize']) win.on(ev, () => pdbg('窗口事件', ev));
  win.on('blur', () => {
    if (!pinned && !win.webContents.isDevToolsOpened()) {
      win.hide();
      lastBlurHide = Date.now();
    }
  });
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function setPinned(value) {
  pinned = value;
  win.setAlwaysOnTop(pinned);
  broadcast('pin-changed', pinned);
}

// ---------- 任务栏小组件 ----------
// 小组件只占用任务栏上的空白，不压住任何图标：读出开始按钮、应用图标、托盘的位置，
// 在剩下的空白里按设置挑一块摆放；空白变窄时自动降级形态（任务卡片 → 紧凑 → 徽标 → 隐藏），开新应用时自动让位。
// 兼容居左 / 居中的任务栏排布（居中时左右各有一块空白）和自动隐藏的任务栏。
let widgetInfo = { source: 'none', mode: null }; // 最近一次布局的详情，给设置面板显示
let lastMode = null;                              // 上一次的形态，用来做滞回
let lastSpace = null, lastSpaceAt = 0;            // 最近一次成功读到的任务栏占用情况
const SPACE_STALE_MS = 4000;
// 调试日志（TM_DEBUG_WIDGET=1）：记录小组件显示/隐藏/移动的时间点和原因，用来排查闪烁
const wlog = (...a) => { if (process.env.TM_DEBUG_WIDGET) console.log('[widget ' + new Date().toISOString().slice(11, 23) + ']', ...a); };

const widgetPrefs = () => {
  const s = settings();
  return { place: s.widgetPlace, gap: s.widgetGap, maxWidth: s.widgetMaxWidth, collapse: s.widgetCollapse, expand: s.widgetExpand };
};

// 任务栏当前露出了多少：自动隐藏收起时，任务栏窗口大部分在屏幕外
function taskbarRevealed(space, display) {
  if (!space) return true;
  const sf = display.scaleFactor;
  const b = display.bounds;
  const screenPx = { left: b.x * sf, top: b.y * sf, right: (b.x + b.width) * sf, bottom: (b.y + b.height) * sf };
  return visibleRatio(space.bar, screenPx) >= 0.9;
}

// 返回小组件的位置与形态；null 表示任务栏上没有合适的空位，应隐藏
function widgetBounds() {
  const display = screen.getPrimaryDisplay();
  const tb = getTaskbar(display);
  const bar = tb.rect || display.bounds;
  const vertical = tb.edge === 'left' || tb.edge === 'right';
  const t = Math.max(28, tb.thickness - 8);
  const s = settings();
  const sf = display.scaleFactor;

  let space = !vertical && getTaskbarSpace();
  if (space) { lastSpace = space; lastSpaceAt = Date.now(); }
  else if (!vertical && lastSpace && Date.now() - lastSpaceAt < SPACE_STALE_MS) space = lastSpace; // 偶尔读不到：沿用上一次，别让小组件跳走
  if (space && !space.vertical) {
    const toDip = ([a, b]) => [a / sf, b / sf];
    const start = Math.max(space.bar.left / sf, display.bounds.x);
    const end = Math.min(space.bar.right / sf, display.bounds.x + display.bounds.width);
    const slot = pickSlot({ start, end, occupied: space.occupied.map(toDip), prefs: widgetPrefs(), prev: lastMode });
    widgetInfo = {
      source: space.source, edge: tb.edge, mode: slot.mode, side: slot.side || null, fellBack: !!slot.fellBack,
      gaps: slot.gaps.map((g) => ({ side: g.side, width: Math.round(g.width), usable: Math.round(g.usable), mode: g.mode })),
    };
    if (!slot.mode) return null;
    const y = Math.round(bar.y + (bar.height - t) / 2);
    const bounds = { x: Math.round(slot.x0), y, width: Math.round(slot.x1 - slot.x0), height: t };
    return { bounds, tb, bar, vertical, mode: slot.mode, draggable: false };
  }

  // 读不到应用图标位置（竖向任务栏，或系统不允许读取）：紧凑形态，位置由用户拖动决定
  widgetInfo = { source: 'none', edge: tb.edge, mode: 'compact', side: null, fellBack: false, gaps: [] };
  const width = vertical ? t : COMPACT_W;
  const height = vertical ? 196 : t;
  const k = Math.min(Math.max(s.widgetOffset, 0), 1);
  const x = vertical ? bar.x + (bar.width - width) / 2 : bar.x + k * (bar.width - width);
  const y = vertical ? bar.y + k * (bar.height - height) : bar.y + (bar.height - height) / 2;
  return { bounds: { x: Math.round(x), y: Math.round(y), width, height }, tb, bar, vertical, mode: 'compact', draggable: true };
}

function createWidget() {
  widget = new BrowserWindow({
    width: 300, height: 40,
    show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  widget.setAlwaysOnTop(true, 'screen-saver');
  widget.loadFile(page('widget.html'));
  widget.once('ready-to-show', applyWidgetVisibility);
}

let widgetLayout = null;
let lastLayoutKey = '';
function layoutWidget() {
  if (!widget || widget.isDestroyed()) return false;
  if (dragStart) return true; // 拖动中不打断
  widgetLayout = widgetBounds();
  if (!widgetLayout) return false;
  const { bounds, vertical, mode, tb } = widgetLayout;
  lastMode = mode;
  const key = JSON.stringify([bounds, vertical, mode]);
  if (key !== lastLayoutKey) { // 只在变化时调整，避免闪烁
    lastLayoutKey = key;
    wlog('布局', mode, JSON.stringify(bounds));
    widget.setBounds(bounds);
    send(widget, 'widget-layout', { vertical, edge: tb.edge, mode });
  }
  return true;
}

// 显示或隐藏小组件。
//   立即生效：用户关掉了小组件；任务栏自动隐藏（设为"不显示"，或任务栏已收起）
//   带缓冲：全屏程序、任务栏上暂时没有空位——这两种读数偶尔会抖一下，持续 HIDE_GRACE 才真正隐藏，不会闪一下
const HIDE_GRACE = 900;
let hideSince = 0;

function applyWidgetVisibility() {
  if (!widget || widget.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const tb = getTaskbar(display);
  const s = settings();

  let hide = null; // [原因, 是否立即生效]
  if (!s.widget) hide = ['已关闭', true];
  else if (tb.autoHide && s.widgetAutoHide === 'hide') hide = ['自动隐藏任务栏时不显示', true];
  else if (tb.autoHide && !taskbarRevealed(getTaskbarSpace(), display)) hide = ['任务栏已收起', true];
  else if (isFullscreenBusy()) hide = ['全屏程序', false];
  else if (!layoutWidget()) hide = ['任务栏上没有空位', false];

  widgetInfo.autoHide = tb.autoHide;
  widgetInfo.revealed = !hide || hide[0] !== '任务栏已收起';

  if (!hide) {
    hideSince = 0;
    if (!widget.isVisible()) {
      wlog('显示');
      widget.showInactive();
      if (!widget.isVisible()) widget.showInactive(); // 同上：第一次显示可能被启动方式吞掉
      widget.setAlwaysOnTop(true, 'screen-saver'); // 只在显示时设置一次；之后由 Z 序检测负责，不再每次轮询都重设
    }
    return;
  }

  if (!hide[1] && widget.isVisible()) {
    hideSince ||= Date.now();
    if (Date.now() - hideSince < HIDE_GRACE) return; // 先观望，可能只是读数抖了一下
  }
  hideSince = 0;
  lastMode = null;
  if (widget.isVisible()) { wlog('隐藏：' + hide[0]); widget.hide(); }
}

// 任务栏也是置顶窗口：用户点开始菜单或任务栏图标时它会跳到小组件上面，把小组件盖住（看起来像小组件闪没了一下）。
// 每 40ms 看一眼 Z 序（单次检查约 0.15ms），被盖住就立刻提回来——比原来每 0.6 秒无条件重新置顶更快，也不会反复触发置顶样式切换。
let raiseTimer = null;
function startRaiseLoop() {
  clearInterval(raiseTimer);
  raiseTimer = setInterval(() => {
    if (!widget || widget.isDestroyed() || !widget.isVisible()) return;
    if (taskbarAbove(widget.getNativeWindowHandle())) { widget.moveTop(); wlog('被任务栏盖住，已提回'); }
  }, 40);
}

// 自动隐藏的任务栏要更快地跟随弹出和收起，平时 0.6 秒检查一次就够了
let widgetTimer = null;
function scheduleWidgetTick() {
  clearTimeout(widgetTimer);
  const follow = widgetInfo.autoHide && settings().widgetAutoHide === 'follow';
  widgetTimer = setTimeout(() => {
    try { applyWidgetVisibility(); } catch (err) { console.error('[widget]', err); }
    scheduleWidgetTick();
    startRaiseLoop();
  }, follow ? 150 : 600);
}

// 系统设置里的任务栏对齐方式（Win11：0 居左，1 居中），仅用于在设置面板里提示
let alignCache = { at: 0, v: null };
function systemTaskbarAlign() {
  if (Date.now() - alignCache.at < 5000) return Promise.resolve(alignCache.v);
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', '/v', 'TaskbarAl'],
      { windowsHide: true, timeout: 2000 }, (err, out) => {
        const m = !err && /TaskbarAl\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
        alignCache = { at: Date.now(), v: m ? (parseInt(m[1], 16) === 0 ? 'left' : 'center') : null };
        resolve(alignCache.v);
      });
  });
}
ipcMain.handle('widget:info', async () => ({ ...widgetInfo, systemAlign: await systemTaskbarAlign() }));

// 沿任务栏方向拖动小组件，松手后记住位置
let dragStart = null;
ipcMain.on('widget:drag', (_e, { phase, dx, dy }) => {
  if (!widgetLayout || !widgetLayout.draggable) return;
  if (phase !== 'start' && !(Number.isFinite(dx) && Number.isFinite(dy))) return;
  const { bounds, bar, vertical } = widgetLayout;
  if (phase === 'start') { dragStart = { ...bounds }; return; }
  if (!dragStart) return;
  const pos = vertical
    ? Math.min(Math.max(dragStart.y + dy, bar.y), bar.y + bar.height - bounds.height)
    : Math.min(Math.max(dragStart.x + dx, bar.x), bar.x + bar.width - bounds.width);
  const b = vertical ? { ...bounds, y: Math.round(pos) } : { ...bounds, x: Math.round(pos) };
  widget.setBounds(b);
  if (phase === 'end') {
    const k = vertical ? (b.y - bar.y) / (bar.height - b.height) : (b.x - bar.x) / (bar.width - b.width);
    dragStart = null;
    updateSettings({ widgetOffset: Math.round(k * 1000) / 1000 });
  }
});
ipcMain.on('widget:click', () => { wlog('点击：开关面板'); toggleWindow(widget.getBounds()); });
ipcMain.on('widget:add', () => { wlog('点击：新建'); showWindow(widget.getBounds(), true); });
ipcMain.on('widget:ready', () => { lastLayoutKey = ''; applyWidgetVisibility(); }); // 页面就绪后重发一次布局

// 小组件 / 菜单上的完成、删除、换象限，都是转给主面板的页面去执行的（经验、连击、统计、音效都在那里）。
// 那个页面卡住或刚好在重载时，转过去的操作就石沉大海：点了没反应，任务栏上的显示也不更新。
// 所以转发之后 1.5 秒内没看到数据保存，就判定页面没响应：重载页面，等它就绪后把操作再发一次。
// （完成 / 删除 / 换到同一象限都是幂等的，页面只是慢了一点、两次都生效也不会出错）
let lastSaveAt = 0;
ipcMain.on('task:op', (_e, op) => {
  if (!op || typeof op !== 'object') return;
  wlog('任务操作', op.op);
  send(win, 'task-op', op);
  const t = data && data.tasks.find((x) => x.id === op.id && !x.done);
  const changes = t && (op.op === 'complete' || op.op === 'delete' || (op.op === 'move' && op.q !== t.q));
  if (!changes) return;
  const sentAt = Date.now();
  setTimeout(() => {
    if (lastSaveAt >= sentAt) return;
    dlog(`任务操作 ${op.op} 转给面板后 1.5 秒没有生效，${panelReady ? '重载面板并' : '等面板就绪后'}重试`);
    if (panelReady) win.webContents.reload();
    let tries = 0;
    const timer = setInterval(() => {
      if (panelReady || ++tries > 40) { clearInterval(timer); if (panelReady) send(win, 'task-op', op); }
    }, 200);
  }, 1500);
});

// 任务右键菜单
ipcMain.on('menu:showTask', (_e, id) => {
  const task = data && data.tasks.find((t) => t.id === id);
  if (!task || !menu) return;
  menuAt = screen.getCursorScreenPoint();
  menuAnchor = null;
  menuWidth = MENU_W;
  send(menu, 'menu-open', { ...menuState(), task });
});

// ---------- 自绘右键菜单 ----------
function createMenu() {
  menu = new BrowserWindow({
    width: MENU_W, height: 400,
    show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  menu.loadFile(page('menu.html'));
  menu.on('blur', () => menu.hide());
}

// 开机自启要登记的程序：便携版每次运行都解压到临时目录，必须登记便携 exe 本身；
// 未打包时 execPath 是 electron.exe，需要把项目路径作为参数带上
const loginItemPath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const loginItemArgs = () => (app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']);
const autoStartOn = () => app.getLoginItemSettings({ path: loginItemPath(), args: loginItemArgs() }).openAtLogin;

function menuState() {
  const today = (data && data.stats && data.stats.daily[dayKey()]) || 0;
  return { settings: settings(), pinned, autoStart: autoStartOn(), counts: openCounts(), today, hotkey: HOTKEY };
}

let menuIdleTimer = null; // 菜单没拿到焦点时的兜底收起计时
let menuAt = null;      // 在鼠标位置弹出（右键菜单）
let menuAnchor = null;  // 贴着某个元素弹出（点任务文字的下拉列表），屏幕 DIP 坐标
let menuWidth = MENU_W;
function showMenu() {
  if (!menu) return;
  menuAt = screen.getCursorScreenPoint();
  menuAnchor = null;
  menuWidth = MENU_W;
  send(menu, 'menu-open', menuState()); // 菜单页量好高度后回调 menu:ready 再显示
}

ipcMain.on('menu:ready', (_e, height) => {
  if ((!menuAt && !menuAnchor) || !Number.isFinite(height)) return;
  const display = screen.getDisplayNearestPoint(menuAnchor ? { x: menuAnchor.x, y: menuAnchor.y } : menuAt);
  const wa = display.workArea; // 工作区不含任务栏，菜单不会压在任务栏上
  const h = Math.ceil(height);
  const W = menuWidth;
  let x, y;
  if (menuAnchor) {
    // 紧贴被点的元素：任务栏在上就往下展开，在下就往上展开，竖向任务栏往旁边展开
    const a = menuAnchor;
    const edge = widgetInfo.edge || 'bottom';
    if (edge === 'left') { x = a.x + a.width + 4; y = a.y; }
    else if (edge === 'right') { x = a.x - W - 4; y = a.y; }
    else { x = a.x; y = edge === 'top' ? a.y + a.height + 6 : a.y - h - 6; }
  } else {
    x = menuAt.x - W;
    y = menuAt.y - h;
    if (x < wa.x) x = menuAt.x;
    if (y < wa.y) y = menuAt.y;
  }
  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - W - 4);
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - h - 4);
  menu.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: h });
  menu.show();
  if (!menu.isVisible()) menu.show(); // 同上：开机自启（不弹面板）时，菜单可能是进程里第一个被显示的窗口
  menu.focus();
  menuAt = null;
  menuAnchor = null;
  // 菜单是从不抢焦点的小组件上点出来的，系统可能拒绝把焦点交给它；而菜单只靠"失焦"自动关闭，没拿到焦点就会一直挂着。
  // 所以：先重试一次拿焦点，10 秒后仍然没焦点就收起
  setTimeout(() => { wlog('菜单焦点', menu.isFocused()); if (menu.isVisible() && !menu.isFocused()) menu.focus(); }, 120);
  clearTimeout(menuIdleTimer);
  menuIdleTimer = setTimeout(() => { if (menu.isVisible() && !menu.isFocused()) menu.hide(); }, 10000);
});

// ---------- 任务栏上点任务文字：下拉出同色的全部任务，选一个替换任务栏上显示的 ----------
// 被选中的任务"钉"在任务栏显示的最前面（data.widgetPins）；钉住的任务做完或删除后自动移除
const PICK_W = 300;
let pickCtx = null;

ipcMain.on('widget:pick', (_e, { q, id, shown, anchor }) => {
  if (!data || !menu || ![1, 2, 3, 4].includes(q) || !anchor || !widget || widget.isDestroyed()) return;
  wlog('点击：下拉', 'Q' + q);
  if (!['x', 'y', 'width', 'height'].every((k) => Number.isFinite(anchor[k]))) return; // 坐标不合法会让 setBounds 抛错
  const wb = widget.getBounds();
  menuAnchor = { x: wb.x + anchor.x, y: wb.y + anchor.y, width: anchor.width, height: anchor.height };
  menuAt = null;
  menuWidth = PICK_W;
  pickCtx = { q, replaceId: typeof id === 'string' ? id : null, shown: new Set(Array.isArray(shown) ? shown : []) };
  send(menu, 'menu-open', { ...menuState(), pick: pickState() });
});

function pickState() {
  const { q, replaceId, shown } = pickCtx;
  const pins = data.widgetPins || [];
  const tasks = data.tasks.filter((t) => !t.done && t.q === q);
  // 钉住的排前面，其余保持原顺序（sort 是稳定的）
  tasks.sort((a, b) => (pins.includes(a.id) ? pins.indexOf(a.id) : 1e9) - (pins.includes(b.id) ? pins.indexOf(b.id) : 1e9));
  return {
    q, hasPins: pins.length > 0,
    tasks: tasks.map((t) => ({ id: t.id, text: t.text, shown: shown.has(t.id), current: t.id === replaceId, pinned: pins.includes(t.id) })),
  };
}

function savePins(pins) {
  data.widgetPins = pins.slice(0, 30);
  saveData();
  broadcast('data-changed', data);
  send(widget, 'widget-picked');
}

function applyPick(id) {
  if (!data || !pickCtx) return;
  const open = new Set(data.tasks.filter((t) => !t.done).map((t) => t.id));
  if (!open.has(id)) return;
  const old = (data.widgetPins || []).filter((p) => open.has(p));
  const { replaceId } = pickCtx;
  if (replaceId === id) return; // 选的就是当前这张，不用改
  if (replaceId && old.includes(replaceId)) {
    savePins(old.filter((p) => p !== id).map((p) => (p === replaceId ? id : p))); // 新任务占据被替换那张的钉住位置
  } else if (replaceId) {
    savePins([...old.filter((p) => p !== id), id]);                               // 接在已钉住的任务后面
  } else {
    savePins([id, ...old.filter((p) => p !== id)]);                               // 点的是计数块：直接排到最前
  }
}

ipcMain.on('menu:action', (_e, { action, value }) => {
  const keepOpen = ['theme', 'skin', 'radius'].includes(action);
  if (!keepOpen) menu.hide();
  switch (action) {
    case 'open': showWindow(tray.getBounds()); break;
    case 'new': showWindow(tray.getBounds(), true); break;
    case 'bar-settings': showWindow(tray.getBounds()); send(win, 'open-bar'); break; // 打开面板并展开小组件设置
    case 'radius': updateSettings({ radius: value }); break;
    case 'widget': updateSettings({ widget: value }); break;
    case 'widgetExpand': updateSettings({ widgetExpand: value }); break;
    case 'diagnose': dumpDiagnostics('手动保存', true).then((f) => { if (f) shell.showItemInFolder(f); }); break; // 看到黑屏时点一下，把现场记下来
    case 'pick-select': if (typeof value === 'string') applyPick(value); break;
    case 'pick-reset': if (data) savePins([]); break;
    case 'task-complete': send(win, 'task-op', { op: 'complete', id: value }); break;
    case 'task-delete': send(win, 'task-op', { op: 'delete', id: value }); break;
    case 'task-move': send(win, 'task-op', { op: 'move', id: value.id, q: value.q }); break;
    case 'task-edit': showWindow(widget.getBounds()); send(win, 'task-op', { op: 'edit', id: value }); break;
    case 'pin': setPinned(value); break;
    case 'sound': updateSettings({ sound: value }); break;
    case 'autostart': app.setLoginItemSettings({ openAtLogin: value, path: loginItemPath(), args: loginItemArgs() }); break;
    case 'theme': updateSettings({ theme: value }); break;
    case 'skin': updateSettings({ skin: value }); break;
    case 'quit': isQuitting = true; app.quit(); break;
  }
  if (keepOpen) send(menu, 'menu-open', menuState());
});

// ---------- IPC：数据 ----------
ipcMain.handle('data:load', () => data);
ipcMain.handle('data:save', (e, next) => {
  // 设置以主进程为准，避免面板里的旧副本覆盖菜单里的改动
  // 钉住的顺序也由主进程管：面板手里的是旧副本，不能覆盖；已完成/已删除的任务从中剔除
  const alive = new Set(((next && next.tasks) || []).filter((t) => !t.done).map((t) => t.id));
  data = {
    ...next, settings: (data && data.settings) || {}, settingsVersion: SETTINGS_VERSION,
    widgetPins: ((data && data.widgetPins) || []).filter((id) => alive.has(id)),
  };
  saveData();
  lastSaveAt = Date.now();
  if (process.env.TM_DEBUG_WIDGET) wlog('数据已保存，待办', data.tasks.filter((t) => !t.done).length);
  broadcast('data-changed', data, e.sender);
  refreshTray();
  return true;
});
ipcMain.handle('settings:get', () => settings());
ipcMain.on('settings:set', (_e, patch) => updateSettings(patch));
ipcMain.on('task:completed', (_e, info) => send(widget, 'task-completed', info));
ipcMain.on('win:hide', () => win.hide());
ipcMain.on('win:pin', (_e, value) => setPinned(value));
ipcMain.handle('win:getPinned', () => pinned);
ipcMain.on('menu:show', showMenu);

// ---------- 启动 ----------
function createTray() {
  tray = new Tray(makeTrayIcon(openCounts()));
  refreshTray();
  tray.on('click', () => toggleWindow(tray.getBounds()));
  tray.on('right-click', showMenu);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    app.setAppUserModelId('com.taskmatrix.app');
    data = loadData();
    // 琥珀、磷光绿两个主题已移除，用过的改回默认
    if (data && data.settings && ['amber', 'phosphor'].includes(data.settings.theme)) data.settings.theme = 'steel';
    migrateSettings();
    createWindow();
    createWidget();
    createMenu();
    createTray();
    watchRenderer('主面板', win);
    watchRenderer('任务栏小组件', widget);
    watchRenderer('菜单', menu);
    // GPU 等子进程崩溃会让窗口显示成黑块，至少要留下记录
    app.on('child-process-gone', (_e, d) => {
      if (isQuitting || d.reason === 'clean-exit') return; // 正常退出不是异常
      dlog(`${d.type} 进程退出：${d.reason}（${d.exitCode}）`);
      dumpDiagnostics(`${d.type} 进程退出：${d.reason}`);
    });
    // 睡眠/唤醒、锁屏、显示器变化：显示表面最容易在这些时候出问题，记下时间，出了黑屏好对
    for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen']) powerMonitor.on(ev, () => dlog(`系统事件：${ev}`));
    for (const ev of ['display-added', 'display-removed']) screen.on(ev, () => dlog(`显示器变化：${ev}`));
    screen.on('display-metrics-changed', (_e, _d, changed) => dlog(`显示器变化：${(changed || []).join(',')}`));
    globalShortcut.register(HOTKEY, () => toggleWindow());

    // 分辨率、缩放或任务栏位置变化时重新贴边
    const relayout = () => {
      if (win.isVisible()) positionWindow();
      applyWidgetVisibility();
    };
    screen.on('display-metrics-changed', relayout);
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);
    // 原版 Win11 任务栏的图标位置由 UI Automation 辅助进程异步读取，读到新结果时立刻重新布局
    onTaskbarUiaUpdate(applyWidgetVisibility);
    scheduleWidgetTick();

    // 手动启动时直接弹出面板，开机自启时静默待命
    if (!process.argv.includes('--hidden')) win.once('ready-to-show', () => showWindow());

    if (DEV_ENVS.some((k) => process.env[k])) loadDevTools();
  });
  app.on('before-quit', () => { isQuitting = true; clearTimeout(widgetTimer); clearInterval(raiseTimer); disposeUia(); });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', (e) => e.preventDefault());
}

// 开发测试工具（dev-tools.js，不随安装包发布）：设了下面任意一个环境变量时才加载，用法见 README 的"开发测试工具"
const DEV_ENVS = ['TM_SNAPSHOT', 'TM_STRESS', 'TM_PICKTEST', 'TM_AUTOHIDE', 'TM_RECTS_FILE', 'TM_HANGTEST', 'TM_BLOCKTEST', 'TM_GPUTEST', 'TM_DIAG'];
function loadDevTools() {
  let dev;
  try {
    dev = require('./dev-tools')({
      win, widget, menu, tray, showWindow, send, broadcast, menuState, updateSettings, getTaskbar, isFullscreenBusy, uiaActive, dumpDiagnostics,
      settings, setPinned, showAt, ackLatency,
      // 这几个会被主程序重新赋值，用 getter 保证读到的永远是最新的
      get data() { return data; },
      get widgetInfo() { return widgetInfo; },
      get widgetLayout() { return widgetLayout; },
      get panelReady() { return panelReady; },
      setMenuAt: (p) => { menuAt = p; },
    });
  } catch (err) {
    console.warn('[dev] 开发测试工具不可用:', err.message);
    return;
  }
  if (process.env.TM_AUTOHIDE) dev.devAutoHide();
  if (process.env.TM_DIAG) dev.devDiag().catch((err) => { console.log('DIAG 出错', err && err.message); app.quit(); });
  if (process.env.TM_GPUTEST) dev.devGpuTest(process.env.TM_GPUTEST, process.env.TM_GPUMODE || 'hidden').catch((err) => { console.log('GPUTEST 出错', err && err.message); app.quit(); });
  if (process.env.TM_BLOCKTEST) dev.devBlockTest(process.env.TM_BLOCKTEST).catch((err) => { console.log('BLOCKTEST 出错', err && err.message); app.quit(); });
  if (process.env.TM_HANGTEST) dev.devHangTest().catch((err) => { console.log('HANGTEST 出错', err && err.message); app.quit(); });
  if (process.env.TM_RECTS_FILE) dev.devRects(process.env.TM_RECTS_FILE);
  if (process.env.TM_SNAPSHOT) dev.devSnapshot();
  if (process.env.TM_STRESS) dev.devStress(process.env.TM_STRESS);
  if (process.env.TM_PICKTEST) dev.devPickTest().catch((err) => { console.log('PICKTEST 出错', err && err.message); app.quit(); });
}
