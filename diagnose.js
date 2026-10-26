// 诊断快照：出现"面板黑屏 / 点击没反应"时，一次性把当时的真实状态记下来，用来分清到底是哪一层出了问题：
//   · 页面进程是否还活着、能否在 0.7 秒内响应一帧          → 页面卡死 / 崩溃，还是正常
//   · Chromium 自己认为面板上画的是什么（capturePage）      → 它认为画好了而屏幕是空的 = 系统合成层的问题；它自己也是空的 = 页面问题
//   · GPU 状态、各进程状态、显示器与电源状态                → 显卡 / 驱动 / 虚拟显示器 / 待机的影响
// 结果追加到 userData/diagnose.log（超过 300KB 自动清空）。所有探测都有超时，页面卡死时也能完成。
const { app, screen, powerMonitor, nativeTheme } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');

const withTimeout = (p, ms, fallback) => Promise.race([
  Promise.resolve(p).catch((e) => ({ error: String((e && e.message) || e) })),
  new Promise((r) => setTimeout(() => r(fallback), ms)),
]);

// 页面里执行的探测：下一帧能不能来、可见性、面板根元素的状态
const PAGE_PROBE = `(async () => {
  const root = document.querySelector('#app');
  const cs = root && getComputedStyle(root);
  const raf = await Promise.race([new Promise((r) => requestAnimationFrame(() => r(true))), new Promise((r) => setTimeout(() => r(false), 700))]);
  return {
    readyState: document.readyState, visibility: document.visibilityState, hidden: document.hidden, hasFocus: document.hasFocus(), 下一帧能到: raf,
    appOpacity: cs && cs.opacity, appClass: root && root.className, appSize: root && [Math.round(root.getBoundingClientRect().width), Math.round(root.getBoundingClientRect().height)],
    bodyBg: getComputedStyle(document.body).backgroundColor, inner: [innerWidth, innerHeight], 任务行数: document.querySelectorAll('.task').length,
  };
})()`;

// 位图（BGRA）里抽样：亮度均值、标准差、出现最多的颜色。标准差≈0 说明是一整块纯色
function sample(bitmap) {
  let n = 0, sum = 0, sum2 = 0;
  const colors = new Map();
  for (let i = 0; i + 3 < bitmap.length; i += 4 * 97) {
    const b = bitmap[i], g = bitmap[i + 1], r = bitmap[i + 2];
    const l = 0.114 * b + 0.587 * g + 0.299 * r;
    n++; sum += l; sum2 += l * l;
    const k = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    colors.set(k, (colors.get(k) || 0) + 1);
  }
  const mean = sum / (n || 1);
  const top = [...colors.entries()].sort((a, b) => b[1] - a[1])[0];
  return { 亮度均值: Math.round(mean), 标准差: Math.round(Math.sqrt(Math.max(0, sum2 / (n || 1) - mean * mean)) * 10) / 10, 最多的颜色: top ? `${top[0]} ×${top[1]}/${n}` : '无' };
}

async function windowInfo(name, w) {
  if (!w || w.isDestroyed()) return { 窗口: name, 状态: '已销毁' };
  const wc = w.webContents;
  return {
    窗口: name, 可见: w.isVisible(), 有焦点: w.isFocused(), 最小化: w.isMinimized(), 置顶: w.isAlwaysOnTop(), 位置大小: w.getBounds(),
    页面崩溃过: wc.isCrashed(), 正在加载: wc.isLoading(), 渲染进程pid: wc.getOSProcessId(),
  };
}

async function collect(ctx, reason) {
  const { win, widget, menu } = ctx;
  const lines = [];
  const add = (k, v) => lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  lines.push(`==== ${new Date().toLocaleString()}  原因：${reason} ====`);
  add('版本', { 程序: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, 系统: os.release(), 已运行秒: Math.round(process.uptime()) });
  add('面板状态', { 页面已就绪: ctx.panelReady(), 显示序号: ctx.showSeq(), 已确认序号: ctx.shownAck() });

  add('显示器', screen.getAllDisplays().map((d) => ({ id: d.id, 位置: d.bounds, 缩放: d.scaleFactor, 内置: d.internal, 色深: d.colorDepth, 刷新率: d.displayFrequency })));
  add('主题', { 深色: nativeTheme.shouldUseDarkColors, 高对比: nativeTheme.shouldUseHighContrastColors });
  try { add('电源', { 空闲状态: powerMonitor.getSystemIdleState(60), 空闲秒: powerMonitor.getSystemIdleTime(), 用电池: powerMonitor.isOnBatteryPower() }); } catch { /* 个别系统读不到 */ }

  add('GPU 特性', app.getGPUFeatureStatus());
  const gi = await withTimeout(app.getGPUInfo('basic'), 2000, '读取超时');
  add('GPU 信息', gi && gi.gpuDevice ? gi.gpuDevice.map((g) => ({ 厂商: g.vendorId, 设备: g.deviceId, 驱动: g.driverVersion, 活动: g.active })) : gi);

  add('各进程', app.getAppMetrics().map((m) => ({ 类型: m.type, pid: m.pid, cpu: Math.round(m.cpu.percentCPUUsage * 10) / 10, 内存MB: Math.round(((m.memory && m.memory.workingSetSize) || 0) / 1024) })));
  for (const [name, w] of [['主面板', win], ['任务栏小组件', widget], ['菜单', menu]]) add('窗口', await windowInfo(name, w));

  // 主面板：页面能不能响应、Chromium 认为画了什么
  if (win && !win.isDestroyed()) {
    add('面板页面探测', await withTimeout(win.webContents.executeJavaScript(PAGE_PROBE), 1500, '页面 1.5 秒内没有响应（卡死或已崩溃）'));
    const img = await withTimeout(win.webContents.capturePage(), 1500, null);
    if (img && !img.error && !img.isEmpty()) {
      const size = img.getSize();
      add('Chromium 认为面板上画的内容', { 尺寸: [size.width, size.height], ...sample(img.toBitmap()) });
    } else {
      add('Chromium 认为面板上画的内容', img && img.error ? '抓取出错：' + img.error : (img ? '空图' : '抓取超时（页面没有响应）'));
    }
  }
  if (widget && !widget.isDestroyed()) add('小组件页面探测', await withTimeout(widget.webContents.executeJavaScript('(async()=>({ raf: await Promise.race([new Promise(r=>requestAnimationFrame(()=>r(true))), new Promise(r=>setTimeout(()=>r(false),700))]), visibility: document.visibilityState, 卡片数: document.querySelectorAll("#items .item").length }))()'), 1500, '页面 1.5 秒内没有响应'));

  try {
    const dl = path.join(app.getPath('userData'), 'debug.log');
    if (fs.existsSync(dl)) add('debug.log 最近几行', fs.readFileSync(dl, 'utf8').trim().split('\n').slice(-6));
  } catch { /* 读不到不影响 */ }
  return lines.join('\n') + '\n\n';
}

// 追加到 diagnose.log，返回文件路径
function save(text) {
  const f = path.join(app.getPath('userData'), 'diagnose.log');
  try {
    if (fs.existsSync(f) && fs.statSync(f).size > 300 * 1024) fs.writeFileSync(f, '');
    fs.appendFileSync(f, text);
  } catch { /* 写不了不影响使用 */ }
  return f;
}

module.exports = { collect, save };
