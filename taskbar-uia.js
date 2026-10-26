// UI Automation 辅助进程的管理：按需启动、节流查询、缓存最近一次结果。
// 主程序是同步轮询任务栏的，所以这里提供"取缓存 + 后台刷新"的接口：get() 立刻返回上次结果并在需要时触发刷新。
const { spawn } = require('child_process');
const path = require('path');

const QUERY_TIMEOUT = 5000;
const MIN_INTERVAL = 700;     // 两次查询的最短间隔
const FRESH_MS = 6000;        // 缓存超过这个时间就当作失效
const MAX_FAILURES = 5;

let proc = null;
let ready = false;
let buffer = '';
let waiting = null;           // 正在等待结果的查询 { timer }
let cache = null;             // { rects, at }
let lastAsk = 0;
let failures = 0;
let retryAt = 0;
let onUpdate = null;

// 打包后脚本会被解到 app.asar.unpacked 里（powershell 读不了 asar 里的文件）
const scriptPath = () => path.join(__dirname, 'uia-taskbar.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

function fail(reason) {
  failures++;
  retryAt = Date.now() + 5000;
  if (failures >= MAX_FAILURES) console.warn('[taskbar-uia] 多次失败，停止尝试:', reason);
}

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.ready) { ready = true; return; }
  if (waiting) { clearTimeout(waiting.timer); waiting = null; }
  if (msg.ok) {
    failures = 0;
    cache = { rects: msg.rects, at: Date.now() };
    if (onUpdate) onUpdate();
  } else {
    fail(msg.error);
  }
}

function start() {
  if (proc || failures >= MAX_FAILURES || Date.now() < retryAt) return;
  ready = false;
  buffer = '';
  try {
    proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  } catch (err) {
    proc = null; fail(err.message); return;
  }
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) handleLine(line);
    }
  });
  proc.on('exit', () => {
    proc = null; ready = false;
    if (waiting) { clearTimeout(waiting.timer); waiting = null; }
    fail('进程退出');
  });
  proc.on('error', (err) => { proc = null; fail(err.message); });
  proc.stdin.on('error', () => {});
}

function refresh() {
  start();
  if (!proc || !ready || waiting || Date.now() - lastAsk < MIN_INTERVAL) return;
  lastAsk = Date.now();
  waiting = { timer: setTimeout(() => { waiting = null; fail('查询超时'); }, QUERY_TIMEOUT) };
  proc.stdin.write('q\n');
}

// 返回最近一次的任务栏按钮矩形（物理像素）；没有或已过期返回 null，同时在后台触发刷新
function getRects() {
  refresh();
  return cache && Date.now() - cache.at < FRESH_MS ? cache.rects : null;
}

function setOnUpdate(fn) { onUpdate = fn; }
function isActive() { return !!proc; }
function dispose() {
  failures = MAX_FAILURES;
  if (proc) { try { proc.kill(); } catch { /* 已退出 */ } proc = null; }
}

module.exports = { getRects, setOnUpdate, isActive, dispose };
