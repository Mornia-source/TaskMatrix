// 任务栏小组件
// 紧凑模式：四象限待办数 + 最该做的一条；展开模式：任务卡片直接排在任务栏上，可勾选完成
// 交互：单击空白开关面板；勾选框完成任务；＋ 新建；右键任务出任务菜单，右键空白出主菜单；紧凑模式可拖动
const $ = (s) => document.querySelector(s);
let data = null;
let mode = 'compact';
const pending = new Set(); // 已点完成、等面板回写数据的任务

const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 按象限优先级排好的待办
const openTasks = () => {
  const open = ((data && data.tasks) || []).filter((t) => !t.done);
  return [1, 2, 3, 4].flatMap((q) => open.filter((t) => t.q === q));
};

function render() {
  const open = openTasks();
  for (const chip of document.querySelectorAll('.chip')) {
    const n = open.filter((t) => t.q === +chip.dataset.q).length;
    chip.querySelector('b').textContent = n;
    chip.classList.toggle('empty', n === 0);
  }

  const next = open[0];
  $('#focus').className = 'focus' + (next ? ' q' + next.q : ' clear');
  $('#focusText').textContent = next ? next.text : 'ALL CLEAR';

  const today = (data && data.stats && data.stats.daily[dayKey()]) || 0;
  const total = today + open.length;
  $('#pfill').style.setProperty('--p', total ? today / total : 0);

  if (mode === 'expanded') renderItems(open);
}

function renderItems(open) {
  const box = $('#items');
  const visible = open.filter((t) => !pending.has(t.id));
  if (!visible.length) {
    box.innerHTML = '<span class="clear-msg">ALL CLEAR · 今日任务全部完成</span>';
    $('#more').hidden = true;
    return;
  }
  box.replaceChildren(...visible.map((t) => {
    const el = document.createElement('div');
    el.className = 'item q' + t.q;
    el.dataset.id = t.id;
    el.title = t.text;
    el.innerHTML = '<span class="check" title="完成"></span><span class="t"></span>';
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
  items.forEach((el) => { el.hidden = false; });
  more.hidden = true;
  const overflows = (el) => el.getBoundingClientRect().right > box.getBoundingClientRect().right + 1;
  let hidden = 0;
  for (const el of items) {
    if (hidden || overflows(el)) { el.hidden = true; hidden++; } // 保持优先级顺序，后面的都收起
  }
  if (hidden) {
    more.hidden = false;
    more.textContent = '+' + hidden;
    // +N 按钮本身占了位置，可能还要再藏一个
    const shown = items.filter((el) => !el.hidden);
    const last = shown[shown.length - 1];
    if (last && overflows(last)) {
      last.hidden = true;
      more.textContent = '+' + (hidden + 1);
    }
  }
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
  const r = chip.getBoundingClientRect();
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

// ---------- 交互 ----------
let down = null;
const bar = $('#bar');
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
  if (target.closest('.check') && item) completeItem(item);
  else if (target.closest('.add')) window.api.widgetAdd();
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

(async () => {
  applyLook(await window.api.getSettings());
  data = await window.api.load();
  render();
  window.api.widgetReady();
  window.api.onSettingsChanged((s) => { applyLook(s); if (mode === 'expanded') setTimeout(fitItems, 0); });
  window.api.onDataChanged((d) => {
    data = d;
    // 已经确认完成的任务不再算"等待中"
    for (const id of [...pending]) if (!d.tasks.some((t) => t.id === id && !t.done)) pending.delete(id);
    render();
  });
  window.api.onTaskCompleted(pulse);
  setInterval(render, 60000); // 跨天刷新进度
})();
