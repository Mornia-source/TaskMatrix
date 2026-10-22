const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const XP_BY_Q = { 1: 30, 2: 25, 3: 10, 4: 5 };
const COMBO_WINDOW = 10000; // 10 秒内连续完成算连击
const SEGMENTS = 20;

let state = null;
let selQ = 1;
let combo = 0;
let lastDoneAt = 0;

// ---------- 数据 ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function defaultState() {
  const now = Date.now();
  const t = (text, q, i) => ({ id: uid() + i, text, q, done: false, createdAt: now + i, doneAt: null });
  return {
    version: 1,
    tasks: [
      t('点击左侧方块完成任务，感受一下反馈', 1, 0),
      t('双击文字可以编辑任务', 2, 1),
      t('把任务拖到别的象限试试', 3, 2),
      t('点右上角 SKN 换主题和皮肤', 4, 3),
    ],
    settings: { theme: 'steel', sound: true },
    stats: { xp: 0, daily: {} },
  };
}

function save() {
  window.api.save(state);
}

// ---------- 等级 ----------
function levelInfo(xp) {
  let lv = 1, need = 50, rest = xp;
  while (rest >= need) { rest -= need; lv++; need = 50 * lv; }
  return { lv, cur: rest, need };
}

function streak() {
  let n = 0;
  const d = new Date();
  if (!state.stats.daily[dayKey(d)]) d.setDate(d.getDate() - 1); // 今天还没完成不算断
  while (state.stats.daily[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// ---------- 外观：主题（配色）+ 皮肤（风格） ----------
function applySettings(s) {
  state.settings = s;
  applyLook(s);
  Sound.setEnabled(s.sound);
  $('#btnSound').classList.toggle('on', s.sound);
  if ($('#skinMenu').classList.contains('open')) renderSkinMenu();
}

function renderSkinMenu() {
  const menu = $('#skinMenu');
  menu.innerHTML = '<div class="title">THEME // 主题配色</div><div class="theme-grid"></div><div class="title">SKIN // 皮肤风格</div><div class="skin-list"></div>';
  for (const [key, theme] of Object.entries(THEMES)) {
    const b = document.createElement('button');
    b.className = 'theme-opt' + (key === state.settings.theme ? ' current' : '');
    const v = theme.vars;
    b.innerHTML = `<span class="sw" style="background:${v.bg}">${[v.q1, v.q2, v.q3, v.q4].map((c) => `<i style="background:${c}"></i>`).join('')}</span><span></span>`;
    b.lastChild.textContent = theme.name;
    b.onclick = () => { window.api.setSettings({ theme: key }); Sound.tick(); };
    $('.theme-grid', menu).appendChild(b);
  }
  for (const [key, skin] of Object.entries(SKINS)) {
    const b = document.createElement('button');
    b.className = 'skin-opt' + (key === state.settings.skin ? ' current' : '');
    b.innerHTML = '<b></b><small></small>';
    b.firstChild.textContent = skin.name;
    b.lastChild.textContent = skin.desc;
    b.onclick = () => { window.api.setSettings({ skin: key }); Sound.tick(); };
    $('.skin-list', menu).appendChild(b);
  }
}

// ---------- 渲染 ----------
function taskEl(task) {
  const li = document.createElement('li');
  li.className = 'task';
  li.dataset.id = task.id;
  li.draggable = true;
  li.innerHTML = '<span class="check" title="完成"></span><span class="text"></span><button class="del" title="删除">✕</button>';
  $('.text', li).textContent = task.text;
  return li;
}

function renderTasks(enterId) {
  for (const quad of $$('.quad')) {
    const q = +quad.dataset.q;
    const list = $('.tasks', quad);
    const items = state.tasks.filter((t) => t.q === q && !t.done);
    list.replaceChildren(...items.map(taskEl));
    $('.count', quad).textContent = items.length;
  }
  if (enterId) {
    const el = $(`.task[data-id="${enterId}"]`);
    if (el) { el.classList.add('enter'); el.scrollIntoView({ block: 'nearest' }); }
  }
  renderStatus();
  renderDone();
}

function renderStatus() {
  const { lv, cur, need } = levelInfo(state.stats.xp);
  $('#lvNum').textContent = lv;
  $('#xpFill').style.width = (cur / need) * 100 + '%';
  $('#xpText').textContent = `${cur}/${need}`;
  const today = state.stats.daily[dayKey()] || 0;
  $('#todayNum').textContent = String(today).padStart(2, '0');
  $('#streakNum').textContent = streak();

  const open = state.tasks.filter((t) => !t.done).length;
  const ratio = today + open ? today / (today + open) : 0;
  const lit = Math.round(ratio * SEGMENTS);
  const bar = $('#segbar');
  if (bar.children.length !== SEGMENTS) bar.innerHTML = '<i></i>'.repeat(SEGMENTS);
  [...bar.children].forEach((s, i) => s.classList.toggle('on', i < lit));
  bar.title = `今日进度 ${today}/${today + open}`;
}

function renderDone() {
  const done = state.tasks.filter((t) => t.done).sort((a, b) => b.doneAt - a.doneAt);
  $('#doneCount').textContent = done.length;
  const list = $('#doneList');
  list.replaceChildren(...done.slice(0, 200).map((t) => {
    const li = document.createElement('li');
    li.className = 'q' + t.q;
    const d = new Date(t.doneAt);
    li.innerHTML = '<span class="bar"></span><span class="t"></span><span class="time"></span><button title="恢复">↺</button>';
    $('.t', li).textContent = t.text;
    $('.time', li).textContent = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    $('button', li).onclick = () => {
      t.done = false; t.doneAt = null;
      save(); renderTasks(t.id); Sound.add();
    };
    return li;
  }));
}

function bump(sel) {
  const el = $(sel);
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

// ---------- 操作 ----------
function selectQ(q) {
  selQ = q;
  $$('#qpick button').forEach((b) => b.classList.toggle('active', +b.dataset.q === q));
  $('#addForm').style.setProperty('--qsel', `var(--q${q})`);
}

function addTask(text) {
  text = text.trim();
  if (!text) return;
  const task = { id: uid(), text, q: selQ, done: false, createdAt: Date.now(), doneAt: null };
  state.tasks.push(task);
  save();
  renderTasks(task.id);
  const quad = $(`.quad[data-q="${selQ}"]`);
  quad.classList.remove('flash'); void quad.offsetWidth; quad.classList.add('flash');
  Sound.add();
}

function completeTask(li) {
  const task = state.tasks.find((t) => t.id === li.dataset.id);
  if (!task || li.classList.contains('completing')) return;

  const now = Date.now();
  combo = now - lastDoneAt < COMBO_WINDOW ? combo + 1 : 1;
  lastDoneAt = now;

  const before = levelInfo(state.stats.xp).lv;
  const gain = Math.round(XP_BY_Q[task.q] * (1 + 0.2 * Math.min(combo - 1, 5)));
  task.done = true;
  task.doneAt = now;
  state.stats.xp += gain;
  const k = dayKey(now);
  state.stats.daily[k] = (state.stats.daily[k] || 0) + 1;
  save();

  // 反馈：粒子 + 飘字 + 震屏 + 音效
  const color = getComputedStyle(li).getPropertyValue('--qc').trim();
  const box = $('.check', li).getBoundingClientRect();
  const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  li.classList.add('completing');
  FX.burst(cx, cy, color, task.q === 1 ? 1.5 : 1 + combo * 0.1);
  FX.floatText(cx + 40, cy - 8, `+${gain} XP`, color);
  Sound.complete(task.q, combo);
  window.api.taskCompleted({ q: task.q, combo, gain });
  const app = $('#app');
  app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
  if (combo >= 3) FX.banner(`COMBO ×${combo}`, '连击');

  renderStatus();
  bump('#todayNum');

  const after = levelInfo(state.stats.xp).lv;
  const allClear = !state.tasks.some((t) => !t.done);
  setTimeout(() => {
    if (after > before) {
      bump('#lvNum');
      FX.banner(`LEVEL ${after}`, '等级提升');
      FX.shower([color, getCss('--accent'), '#ffffff']);
      Sound.levelUp();
    } else if (allClear) {
      FX.banner('ALL CLEAR', '今日任务全部完成');
      FX.shower(['--q1', '--q2', '--q3', '--accent'].map(getCss));
      Sound.allClear();
    }
  }, 350);

  // 动画结束后刷新列表；面板隐藏时动画事件可能不触发，用定时器兜底
  let refreshed = false;
  const refresh = () => { if (!refreshed) { refreshed = true; renderTasks(); } };
  li.addEventListener('animationend', (e) => { if (e.animationName === 'done-out') refresh(); });
  setTimeout(refresh, 900);
}

// 来自任务栏小组件 / 右键菜单的操作
function handleTaskOp({ op, id, q }) {
  const li = $(`.task[data-id="${id}"]`);
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.done) return;
  if (op === 'complete' && li) completeTask(li);
  if (op === 'delete' && li) deleteTask(li);
  if (op === 'edit' && li) startEdit(li);
  if (op === 'move' && q !== task.q) {
    task.q = q;
    save();
    renderTasks(task.id);
    Sound.tick();
  }
}

function deleteTask(li) {
  li.classList.add('removing');
  Sound.remove();
  setTimeout(() => {
    state.tasks = state.tasks.filter((t) => t.id !== li.dataset.id);
    save();
    renderTasks();
  }, 240);
}

function startEdit(li) {
  const text = $('.text', li);
  const task = state.tasks.find((t) => t.id === li.dataset.id);
  if (!task || text.isContentEditable) return;
  li.draggable = false;
  text.contentEditable = 'true';
  text.focus();
  document.getSelection().selectAllChildren(text);

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    text.contentEditable = 'false';
    li.draggable = true;
    const v = text.textContent.trim();
    if (commit && v && v !== task.text) { task.text = v; save(); }
    if (commit && !v) { deleteTask(li); return; }
    text.textContent = task.text;
  };
  text.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  text.onblur = () => finish(true);
}

const getCss = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- 拖拽 ----------
let dragId = null;
function setupDrag() {
  const matrix = $('#matrix');
  matrix.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.task');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  matrix.addEventListener('dragend', () => {
    dragId = null;
    $$('.dragging').forEach((el) => el.classList.remove('dragging'));
    $$('.dragover').forEach((el) => el.classList.remove('dragover'));
  });
  for (const quad of $$('.quad')) {
    quad.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      quad.classList.add('dragover');
    });
    quad.addEventListener('dragleave', (e) => {
      if (!quad.contains(e.relatedTarget)) quad.classList.remove('dragover');
    });
    quad.addEventListener('drop', (e) => {
      e.preventDefault();
      quad.classList.remove('dragover');
      const idx = state.tasks.findIndex((t) => t.id === dragId);
      if (idx < 0) return;
      const [task] = state.tasks.splice(idx, 1);
      task.q = +quad.dataset.q;
      // 放在哪个任务上就插到它前面，否则放到末尾
      const target = e.target.closest('.task');
      const tIdx = target ? state.tasks.findIndex((t) => t.id === target.dataset.id) : -1;
      if (tIdx >= 0) state.tasks.splice(tIdx, 0, task);
      else state.tasks.push(task);
      save();
      renderTasks(task.id);
      Sound.tick();
    });
  }
}

// ---------- 初始化 ----------
function tickClock() {
  const d = new Date();
  $('#clock').textContent = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

function closeOverlays() {
  const open = $('#skinMenu.open') || $('#drawer.open');
  $('#skinMenu').classList.remove('open');
  $('#drawer').classList.remove('open');
  return !!open;
}

async function init() {
  const loaded = await window.api.load();
  state = loaded || defaultState();
  state.stats ||= { xp: 0, daily: {} };
  applySettings(await window.api.getSettings());
  if (!loaded) save(); // 首次运行，把示例任务交给主进程（小组件和托盘也要用）
  window.api.onSettingsChanged(applySettings);
  window.api.onTaskOp(handleTaskOp);
  selectQ(1);
  renderTasks();
  tickClock();
  setInterval(tickClock, 1000);
  setupDrag();

  const input = $('#taskInput');
  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    addTask(input.value);
    input.value = '';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      selectQ(e.shiftKey ? ((selQ + 2) % 4) + 1 : (selQ % 4) + 1);
      Sound.tick();
    }
  });
  $$('#qpick button').forEach((b) => b.addEventListener('click', () => { selectQ(+b.dataset.q); input.focus(); }));

  $('#matrix').addEventListener('click', (e) => {
    const li = e.target.closest('.task');
    if (!li) return;
    if (e.target.closest('.check')) completeTask(li);
    else if (e.target.closest('.del')) deleteTask(li);
  });
  $('#matrix').addEventListener('dblclick', (e) => {
    const li = e.target.closest('.task');
    if (li && e.target.closest('.text')) startEdit(li);
  });
  // 点象限空白处 = 切到该象限并聚焦输入框
  $$('.quad').forEach((quad) => quad.addEventListener('click', (e) => {
    if (e.target.closest('.task')) return;
    selectQ(+quad.dataset.q);
    input.focus();
  }));

  $('#btnClose').onclick = () => window.api.hide();
  $('#btnSound').onclick = () => {
    window.api.setSettings({ sound: !state.settings.sound });
    Sound.setEnabled(true);
    Sound.tick();
  };
  const setPinUi = (v) => $('#btnPin').classList.toggle('on', v);
  $('#btnPin').onclick = () => window.api.setPinned(!$('#btnPin').classList.contains('on'));
  window.api.onPinChanged(setPinUi);
  setPinUi(await window.api.getPinned());

  $('#btnSkin').onclick = (e) => {
    e.stopPropagation();
    renderSkinMenu();
    $('#skinMenu').classList.toggle('open');
  };
  $('#btnDone').onclick = () => $('#drawer').classList.toggle('open');
  $('#btnCloseDrawer').onclick = () => $('#drawer').classList.remove('open');
  $('#btnClearDone').onclick = () => {
    if (!state.tasks.some((t) => t.done)) return;
    if (!confirm('清空所有已完成记录？（经验值和统计会保留）')) return;
    state.tasks = state.tasks.filter((t) => !t.done);
    save();
    renderTasks();
  };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#skinMenu')) $('#skinMenu').classList.remove('open');
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && ['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      selectQ(+e.key);
      input.focus();
    }
    if (e.key === 'Escape' && !closeOverlays()) window.api.hide();
  });

  // 滑入动画结束后去掉类名，否则会挡住完成任务时的震屏动画
  $('#app').addEventListener('animationend', (e) => {
    if (e.animationName === 'slide-in') e.currentTarget.classList.remove('from-top', 'from-bottom', 'from-left', 'from-right');
  });
  window.api.onShown(({ edge, focusInput }) => {
    renderStatus(); // 跨天后刷新统计
    // 从任务栏所在的那一边滑出
    const app = $('#app');
    app.classList.remove('from-top', 'from-bottom', 'from-left', 'from-right');
    void app.offsetWidth;
    app.classList.add('from-' + (edge || 'bottom'));
    if (focusInput) input.select();
    input.focus();
  });
  input.focus();
}

init();
