const { app, BrowserWindow, Tray, ipcMain, globalShortcut, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { placeNear, getTaskbar, isFullscreenBusy } = require('./taskbar');
const { getTaskbarSpace } = require('./taskbar-space');

process.on('unhandledRejection', (err) => console.error('[main] unhandled:', err));
// 开发用：把数据目录指到别处，测试时不碰真实任务
if (process.env.TM_USERDATA) app.setPath('userData', process.env.TM_USERDATA);

const WIN_W = 440;
const WIN_H = 680;
const HOTKEY = 'Alt+Shift+Q';
const MENU_W = 248;
const DEFAULT_SETTINGS = { theme: 'steel', skin: 'industrial', sound: true, widget: true, widgetExpand: true, widgetOffset: 0.66 };

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

function updateSettings(patch) {
  data ||= { version: 1, tasks: [], stats: { xp: 0, daily: {} } };
  data.settings = { ...settings(), ...patch };
  saveData();
  broadcast('settings-changed', data.settings);
  applyWidgetVisibility();
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
function showWindow(anchor = null, focusInput = false) {
  if (!win) return;
  positionWindow(anchor);
  win.show();
  win.focus();
  send(win, 'window-shown', { edge: lastEdge, focusInput });
}

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
const SPACE_GAP = 10;        // 和应用按钮、托盘之间留的缝
const EXPANDED_MIN = 260;    // 空白够这么宽才展开显示任务
const EXPANDED_MAX = 900;
const COMPACT_W = 300;
const COMPACT_MIN = 150;     // 再窄就隐藏，不和应用按钮抢位置

// 读取任务栏空白（物理像素）并换算成 DIP；读不到返回 null
function freeSpan(display) {
  const space = getTaskbarSpace();
  if (!space || space.vertical) return null;
  const a = screen.screenToDipPoint({ x: space.free[0], y: space.bar.top });
  const b = screen.screenToDipPoint({ x: space.free[1], y: space.bar.top });
  if (a.x < display.bounds.x || b.x > display.bounds.x + display.bounds.width) return null;
  return { start: a.x + SPACE_GAP, end: b.x - SPACE_GAP, buttons: space.buttons };
}

// 返回小组件的位置与模式；mode: expanded（显示任务） / compact（只显示计数）；null 表示应隐藏
function widgetBounds() {
  const display = screen.getPrimaryDisplay();
  const tb = getTaskbar(display);
  const bar = tb.rect || display.bounds;
  const vertical = tb.edge === 'left' || tb.edge === 'right';
  const t = Math.max(28, tb.thickness - 8);
  const s = settings();

  // 能读到应用按钮位置时，自动占用"最后一个应用按钮"到"托盘"之间的空白
  const span = !vertical && freeSpan(display);
  if (span) {
    const room = Math.floor(span.end - span.start);
    const y = Math.round(bar.y + (bar.height - t) / 2);
    if (s.widgetExpand && room >= EXPANDED_MIN) {
      const width = Math.min(room, EXPANDED_MAX);
      return { bounds: { x: Math.round(span.end - width), y, width, height: t }, tb, bar, vertical, mode: 'expanded', draggable: false };
    }
    if (room >= COMPACT_MIN) {
      const width = Math.min(room, COMPACT_W);
      return { bounds: { x: Math.round(span.end - width), y, width, height: t }, tb, bar, vertical, mode: 'compact', draggable: false };
    }
    return null;
  }

  // 读不到（原版 Win11 任务栏 / 竖向任务栏）：紧凑模式，位置由用户拖动决定
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
  const key = JSON.stringify([bounds, vertical, mode]);
  if (key !== lastLayoutKey) { // 只在变化时调整，避免闪烁
    lastLayoutKey = key;
    widget.setBounds(bounds);
    send(widget, 'widget-layout', { vertical, edge: tb.edge, mode });
  }
  return true;
}

// 任务栏自动隐藏、有全屏程序（游戏、视频、演示）、或任务栏上没有空位时收起小组件
function applyWidgetVisibility() {
  if (!widget || widget.isDestroyed()) return;
  const tb = getTaskbar(screen.getPrimaryDisplay());
  const want = settings().widget && !tb.autoHide && !isFullscreenBusy() && layoutWidget();
  if (want) {
    if (!widget.isVisible()) widget.showInactive();
    // 任务栏被点击后会盖到最上层，定期把小组件提回来
    widget.setAlwaysOnTop(true, 'screen-saver');
    widget.moveTop();
  } else if (widget.isVisible()) {
    widget.hide();
  }
}

// 沿任务栏方向拖动小组件，松手后记住位置
let dragStart = null;
ipcMain.on('widget:drag', (_e, { phase, dx, dy }) => {
  if (!widgetLayout || !widgetLayout.draggable) return;
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
ipcMain.on('widget:click', () => toggleWindow(widget.getBounds()));
ipcMain.on('widget:add', () => showWindow(widget.getBounds(), true));
ipcMain.on('widget:ready', () => { lastLayoutKey = ''; applyWidgetVisibility(); }); // 页面就绪后重发一次布局

// 小组件/菜单上的任务操作都交给面板执行（经验、连击、统计、音效都在面板里）
ipcMain.on('task:op', (_e, op) => send(win, 'task-op', op));

// 任务右键菜单
ipcMain.on('menu:showTask', (_e, id) => {
  const task = data && data.tasks.find((t) => t.id === id);
  if (!task || !menu) return;
  menuAt = screen.getCursorScreenPoint();
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

let menuAt = null;
function showMenu() {
  if (!menu) return;
  menuAt = screen.getCursorScreenPoint();
  send(menu, 'menu-open', menuState()); // 菜单页量好高度后回调 menu:ready 再显示
}

ipcMain.on('menu:ready', (_e, height) => {
  if (!menuAt) return;
  const display = screen.getDisplayNearestPoint(menuAt);
  const wa = display.workArea; // 工作区不含任务栏，菜单不会压在任务栏上
  const h = Math.ceil(height);
  let x = menuAt.x - MENU_W;
  let y = menuAt.y - h;
  if (x < wa.x) x = menuAt.x;
  if (y < wa.y) y = menuAt.y;
  x = Math.min(Math.max(x, wa.x + 4), wa.x + wa.width - MENU_W - 4);
  y = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - h - 4);
  menu.setBounds({ x: Math.round(x), y: Math.round(y), width: MENU_W, height: h });
  menu.show();
  menu.focus();
  menuAt = null;
});

ipcMain.on('menu:action', (_e, { action, value }) => {
  const keepOpen = ['theme', 'skin'].includes(action);
  if (!keepOpen) menu.hide();
  switch (action) {
    case 'open': showWindow(tray.getBounds()); break;
    case 'new': showWindow(tray.getBounds(), true); break;
    case 'widget': updateSettings({ widget: value }); break;
    case 'widgetExpand': updateSettings({ widgetExpand: value }); break;
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
  data = { ...next, settings: settings() }; // 设置以主进程为准，避免面板旧副本覆盖菜单里的改动
  saveData();
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
    createWindow();
    createWidget();
    createMenu();
    createTray();
    globalShortcut.register(HOTKEY, () => toggleWindow());

    // 分辨率、缩放或任务栏位置变化时重新贴边
    const relayout = () => {
      if (win.isVisible()) positionWindow();
      applyWidgetVisibility();
    };
    screen.on('display-metrics-changed', relayout);
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);
    setInterval(applyWidgetVisibility, 1500);

    // 手动启动时直接弹出面板，开机自启时静默待命
    if (!process.argv.includes('--hidden')) win.once('ready-to-show', () => showWindow());

    if (process.env.TM_SNAPSHOT) devSnapshot();
  });
  app.on('before-quit', () => { isQuitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', (e) => e.preventDefault());
}

// 开发用：TM_SNAPSHOT=目录 时把三个窗口各截一张图，并打印渲染进程日志
function devSnapshot() {
  const dir = process.env.TM_SNAPSHOT;
  for (const [name, w] of [['panel', win], ['widget', widget], ['menu', menu]]) {
    w.webContents.on('console-message', (e) => console.log(`[${name}]`, e.message));
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  setTimeout(async () => {
    // TM_LOOK=皮肤,主题：只在内存里切换外观，不写入用户设置
    if (process.env.TM_LOOK) {
      const [skin, theme] = process.env.TM_LOOK.split(',');
      data.settings = { ...settings(), skin, theme };
      broadcast('settings-changed', data.settings);
      await wait(500);
    }
    console.log('taskbar', JSON.stringify(getTaskbar(screen.getPrimaryDisplay())), 'fullscreenBusy', isFullscreenBusy());
    // 小组件和菜单是透明窗口，capturePage 截不出来，只截面板；另两个用屏幕截图检查
    try {
      fs.writeFileSync(path.join(dir, 'panel.png'), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      console.log('panel capture failed:', err.message);
    }
    menuAt = { x: 1500, y: 30 };
    send(menu, 'menu-open', menuState());
    await wait(600);
    for (const [name, w] of [['panel', win], ['widget', widget], ['menu', menu]]) {
      console.log(name, JSON.stringify(w.getBounds()), 'visible', w.isVisible());
    }
    // 菜单反复开关自检（曾经出现过只能打开一次的问题）
    for (let i = 1; i <= 3; i++) {
      menu.hide();
      await wait(1500);
      menuAt = { x: 1500, y: 30 };
      send(menu, 'menu-open', menuState());
      await wait(500);
      console.log(`menu reopen #${i} visible`, menu.isVisible());
    }
    console.log('widget layout', JSON.stringify(widgetLayout && { ...widgetLayout.bounds, mode: widgetLayout.mode }));
    console.log('widget items', await widget.webContents.executeJavaScript(
      "JSON.stringify([...document.querySelectorAll('.item')].map(e => (e.hidden ? '(hidden) ' : '') + e.textContent).concat(document.querySelector('#more').hidden ? [] : [document.querySelector('#more').textContent]))"));
    // 任务菜单
    menu.hide();
    await wait(300);
    const first = data.tasks.find((t) => !t.done);
    menuAt = { x: 900, y: 30 };
    send(menu, 'menu-open', { ...menuState(), task: first });
    await wait(600);
    console.log('task menu visible', menu.isVisible(), JSON.stringify(menu.getBounds()));
    if (process.env.TM_CLICK) {
      // 模拟在小组件上勾选第一条任务，确认面板（隐藏状态）能完成并回写
      menu.hide();
      const before = data.tasks.filter((t) => !t.done).length;
      await widget.webContents.executeJavaScript("document.querySelector('.item .check').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 1})); document.querySelector('#bar').dispatchEvent(new PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 1}))");
      await wait(400);
      process.env.TM_GRAB_NOW && console.log('GRAB_NOW');
      await wait(1600);
      console.log('open tasks before', before, 'after', data.tasks.filter((t) => !t.done).length, 'xp', data.stats.xp, 'panel visible', win.isVisible());
    }
    console.log('snapshot done');
  }, 2000);
}
