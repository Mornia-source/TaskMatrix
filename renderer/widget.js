// 任务栏小组件
// 形态：紧凑 = 有任务的象限计数 + 一条任务；展开 = 任务卡片直接排在任务栏上；徽标 = 一个数字
// 交互：勾选框完成任务；点任务文字（或象限计数块）下拉出同色的全部任务，选一个替换任务栏上显示的；
//       ＋ 新建；点空白处开关面板；右键任务出任务菜单，右键空白出主菜单；紧凑形态可拖动
const $ = (s) => document.querySelector(s);
let data = null;
let mode = 'compact';
const pending = new Set(); // 已点完成、等面板回写数据的任务

// 设置里的轮换参数；rot 是轮换到了第几个
let cfg = { rotate: false, sec: 8 };
let rot = 0;
let rotTimer = null;
let hovering = false;     // 鼠标停在小组件上时不轮换，免得点的时候内容突然变了
let pauseUntil = 0;       // 手动选过任务后暂停轮换一阵，让用户看到自己选的
let lastShown = 0, lastHidden = 0; // 最近一次展开布局里显示 / 放不下的卡片数
let focusTaskId = null;   // 紧凑形态里正在显示的那条任务

const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 任务栏显示的顺序：被"钉住"的在最前（用户选过的），其余按象限优先级
function ordered() {
  const open = ((data && data.tasks) || []).filter((t) => !t.done);
  const pins = (data && data.widgetPins) || [];
  const pinned = pins.map((id) => open.find((t) => t.id === id)).filter(Boolean);
  const rest = [1, 2, 3, 4].flatMap((q) => open.filter((t) => t.q === q && !pins.includes(t.id)));
  return [...pinned, ...rest];
}

// 轮换后的顺序：从第 rot 个开始往后排
function displayList() {
  const list = ordered();
  if (!cfg.rotate || list.length < 2) return list;
  const k = rot % list.length;
  return list.slice(k).concat(list.slice(0, k));
}

function render() {
  const all = ordered();
  const list = displayList();

  // 没有任务的象限，对应的颜色块直接不显示
  let anyChip = false;
  for (const chip of document.querySelectorAll('.chip')) {
    const n = all.filter((t) => t.q === +chip.dataset.q).length;
    chip.querySelector('b').textContent = n;
    chip.hidden = n === 0;
    anyChip = anyChip || n > 0;
  }
  $('.chips').hidden = !anyChip;

  const next = list[0];
  focusTaskId = next ? next.id : null;
  $('#focus').className = 'focus' + (next ? ' q' + next.q : ' clear');
  $('#focusText').textContent = next ? next.text : 'ALL CLEAR';
  $('#focus').title = next ? '点击查看同色的全部任务，可替换显示' : '';

  // 徽标：待办总数，颜色取最该做的那条所在象限；悬停提示里写出具体内容
  const top = all[0];
  const badge = $('#badge');
  badge.className = 'badge' + (top ? ' q' + top.q : ' clear');
  $('#badgeN').textContent = all.length;
  badge.title = top ? `${all.length} 项待办，最该做：${top.text}` : '任务全部完成';

  const today = (data && data.stats && data.stats.daily[dayKey()]) || 0;
  const total = today + all.length;
  $('#pfill').style.setProperty('--p', total ? today / total : 0);

  if (mode === 'expanded') renderItems(list);
}

function renderItems(list) {
  const box = $('#items');
  const visible = list.filter((t) => !pending.has(t.id));
  if (!visible.length) {
    box.innerHTML = '<span class="clear-msg">ALL CLEAR · 今日任务全部完成</span>';
    $('#more').hidden = true;
    lastShown = lastHidden = 0;
    return;
  }
  box.replaceChildren(...visible.map((t) => {
    const el = document.createElement('div');
    el.className = 'item q' + t.q;
    el.dataset.id = t.id;
    el.title = t.text + '\n点击文字：查看同色的全部任务，可替换显示';
    el.innerHTML = '<span class="hit" title="完成"><span class="check"></span></span><span class="t"></span>';
    el.lastChild.textContent = t.text;
    return el;
  }));
  fitItems();
}

// 放不下的卡片隐藏起来，用 +N 表示
function fitItems() {
  const box = $('#items');
  const more = $('#more');
  const items = [...box.querySelectorAll('.item')];
  items.forEach((el) => { el.hidden = false; el.style.maxWidth = ''; });
  more.hidden = true;
  const overflows = (el) => el.getBoundingClientRect().right > box.getBoundingClientRect().right + 1;
  let hidden = 0;
  for (const el of items) {
    if (hidden || overflows(el)) { el.hidden = true; hidden++; } // 保持顺序，后面的都收起
  }
  const done = () => { lastHidden = items.filter((el) => el.hidden).length; lastShown = items.length - lastHidden; };
  if (!hidden) return done();

  more.hidden = false;
  more.textContent = '+' + hidden;
  if (hidden === items.length) {
    // 连一张完整的卡片都放不下：至少留下第一张，文字截断显示
    items[0].hidden = false;
    items[0].style.maxWidth = Math.max(80, box.clientWidth - more.offsetWidth - 6) + 'px';
    hidden--;
    more.hidden = hidden === 0;
    more.textContent = '+' + hidden;
    return done();
  }
  // +N 按钮本身占了位置，可能还要再藏一个
  const shown = items.filter((el) => !el.hidden);
  const last = shown[shown.length - 1];
  if (last && overflows(last)) {
    last.hidden = true;
    more.textContent = '+' + (hidden + 1);
  }
  done();
}

// ---------- 自动轮换 ----------
function flashRotate() {
  const el = mode === 'expanded' ? $('#items') : $('#focus');
  el.classList.remove('rot-in');
  void el.offsetWidth;
  el.classList.add('rot-in');
}

function rotateOnce() {
  if (!cfg.rotate || hovering || Date.now() < pauseUntil) return;
  const n = ordered().length;
  if (n < 2) return;
  if (mode === 'expanded') {
    if (lastHidden === 0) return; // 卡片全放得下，没必要轮换
    rot = (rot + Math.max(1, lastShown)) % n; // 整页翻：下一批卡片
  } else if (mode === 'compact') {
    rot = (rot + 1) % n;
  } else {
    return; // 徽标形态只显示数字
  }
  render();
  flashRotate();
}

function restartRotation() {
  clearInterval(rotTimer);
  rotTimer = null;
  if (!cfg.rotate) { rot = 0; return; }
  rotTimer = setInterval(rotateOnce, Math.max(3, cfg.sec) * 1000);
}

// ---------- 反馈效果 ----------
const canvas = $('#fx');
const g = canvas.getContext('2d');
let sparks = [];
function burst(x, y, color) {
  const dpr = devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 3;
    sparks.push({ x, y, vx: Math.cos(a) * s * 1.6, vy: Math.sin(a) * s, life: 1, color: Math.random() < 0.8 ? color : '#fff' });
  }
  if (sparks.length === 22) requestAnimationFrame(tick);
}
function tick() {
  g.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  sparks = sparks.filter((p) => p.life > 0);
  for (const p of sparks) {
    p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.life -= 0.035;
    g.globalAlpha = Math.max(0, p.life);
    g.fillStyle = p.color;
    g.fillRect(p.x - 1, p.y - 1, 2.5, 2.5);
  }
  g.globalAlpha = 1;
  if (sparks.length) requestAnimationFrame(tick);
}

function popText(x, y, text, q) {
  const pop = document.createElement('span');
  pop.className = 'pop q' + q;
  pop.textContent = text;
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  $('#pop').appendChild(pop);
  setTimeout(() => pop.remove(), 900);
}

// 面板完成任务后（不论从哪里发起）：象限计数闪一下、飘出经验值
function pulse({ q, gain }) {
  const chip = document.querySelector(`.chip[data-q="${q}"]`);
  chip.classList.remove('pulse');
  void chip.offsetWidth;
  chip.classList.add('pulse');
  const bar = $('#bar');
  bar.classList.remove('flash');
  void bar.offsetWidth;
  bar.classList.add('flash');
  // 徽标形态下计数块是隐藏的；刚完成的是该象限最后一条时计数块也隐藏了，这时从整条小组件中间飘出
  const anchor = mode === 'badge' ? $('#badge') : (chip.hidden || !chip.offsetWidth ? $('#bar') : chip);
  const r = anchor.getBoundingClientRect();
  popText(r.left + r.width / 2, r.top, '+' + gain, q);
}

function completeItem(item) {
  const id = item.dataset.id;
  if (pending.has(id)) return;
  pending.add(id);
  item.classList.add('completing');
  const c = item.querySelector('.check').getBoundingClientRect();
  const color = getComputedStyle(item).getPropertyValue('--qc').trim();
  burst(c.left + c.width / 2, c.top + c.height / 2, color);
  window.api.taskOp({ op: 'complete', id });
  // 动画播完后由新数据重新渲染；万一面板没回写，2 秒后恢复显示
  setTimeout(() => { if (pending.delete(id)) render(); }, 2000);
}

// ---------- 点任务文字 / 计数块：下拉出同色的全部任务 ----------
function openPick(q, id, el) {
  const r = el.getBoundingClientRect();
  const shown = mode === 'expanded'
    ? [...document.querySelectorAll('#items .item:not([hidden])')].map((e) => e.dataset.id)
    : (mode === 'compact' && focusTaskId ? [focusTaskId] : []);
  pauseUntil = Date.now() + 30000; // 选的时候别轮换
  window.api.widgetPick({ q, id, shown, anchor: { x: r.left, y: r.top, width: r.width, height: r.height } });
}

// ---------- 交互 ----------
let down = null;
const bar = $('#bar');
bar.addEventListener('pointerenter', () => { hovering = true; });
bar.addEventListener('pointerleave', () => { hovering = false; });
bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY, dragging: false, target: e.target };
  bar.setPointerCapture(e.pointerId);
});
bar.addEventListener('pointermove', (e) => {
  if (!down || mode === 'expanded') return; // 展开模式位置自动计算，不可拖
  const dx = e.screenX - down.x, dy = e.screenY - down.y;
  if (!down.dragging && Math.hypot(dx, dy) > 4) {
    down.dragging = true;
    bar.classList.add('dragging');
    window.api.widgetDrag({ phase: 'start' });
  }
  if (down.dragging) window.api.widgetDrag({ phase: 'move', dx, dy });
});
bar.addEventListener('pointerup', (e) => {
  if (!down) return;
  const { target, dragging, x, y } = down;
  down = null;
  bar.classList.remove('dragging');
  if (dragging) {
    window.api.widgetDrag({ phase: 'end', dx: e.screenX - x, dy: e.screenY - y });
    return;
  }
  const item = target.closest('.item');
  const chip = target.closest('.chip');
  const focus = target.closest('.focus');
  const task = (id) => ((data && data.tasks) || []).find((t) => t.id === id);

  if (target.closest('.hit') && item) completeItem(item);
  else if (target.closest('.add')) window.api.widgetAdd();
  else if (item && target.closest('.t')) { const t = task(item.dataset.id); if (t) openPick(t.q, t.id, item); }
  else if (focus && !focus.classList.contains('clear') && focusTaskId) { const t = task(focusTaskId); if (t) openPick(t.q, t.id, focus); }
  else if (chip && !chip.hidden) openPick(+chip.dataset.q, null, chip);
  else window.api.widgetClick();
});
bar.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const item = e.target.closest('.item');
  if (item) window.api.showTaskMenu(item.dataset.id);
  else window.api.showMenu();
});
addEventListener('resize', () => { if (mode === 'expanded') fitItems(); });

// 布局消息可能在数据加载完之前就到，所以监听要先注册，准备好后再主动要一次布局
window.api.onWidgetLayout((l) => {
  mode = l.mode;
  document.body.className = 'mode-' + l.mode + (l.vertical ? ' vertical' : '');
  document.body.dataset.edge = l.edge;
  render();
});

function applyConfig(s) {
  applyLook(s);
  cfg = { rotate: !!s.widgetRotate, sec: Number(s.widgetRotateSec) || 8 };
  restartRotation();
}

(async () => {
  applyConfig(await window.api.getSettings());
  data = await window.api.load();
  render();
  window.api.widgetReady();
  window.api.onSettingsChanged((s) => { applyConfig(s); render(); if (mode === 'expanded') setTimeout(fitItems, 0); });
  window.api.onDataChanged((d) => {
    data = d;
    // 已经确认完成的任务不再算"等待中"
    for (const id of [...pending]) if (!d.tasks.some((t) => t.id === id && !t.done)) pending.delete(id);
    render();
  });
  window.api.onTaskCompleted(pulse);
  // 用户手动选了任务：从头开始显示，并暂停轮换一阵
  window.api.onWidgetPicked(() => { rot = 0; pauseUntil = Date.now() + 30000; render(); });
  setInterval(render, 60000); // 跨天刷新进度
})();
