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
  // 正在拖滑块时不能重建界面（会打断拖动）；松手后滑块失焦，下一次更新再重绘
  const dragging = document.activeElement && document.activeElement.type === 'range';
  if (!dragging) {
    if ($('#skinMenu').classList.contains('open')) renderSkinMenu();
    if ($('#barMenu').classList.contains('open')) renderBarMenu();
  }
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
  if (state.settings.skin === 'minimal') menu.appendChild(radiusRow());
}

// ---------- 圆角（极简皮肤） ----------
const RADIUS_PRESETS = [['直角', 0], ['小', 6], ['默认', 12], ['大', 18]];
const radiusLabel = (n) => (+n === 0 ? '直角' : n + 'px');

// 设置变更先在本地立即预览，再合并后统一发给主进程保存
const pushSettings = (() => {
  let timer = null, pending = {};
  return (patch) => {
    Object.assign(pending, patch);
    clearTimeout(timer);
    timer = setTimeout(() => { window.api.setSettings(pending); pending = {}; }, 80);
  };
})();

function radiusRow() {
  const row = document.createElement('div');
  row.className = 'rad';
  row.innerHTML = '<div class="title">CORNER // 圆角</div>'
    + '<div class="rad-row"><input type="range" min="0" max="20" step="1" aria-label="圆角"><b></b></div>'
    + '<div class="presets"></div>';
  const range = $('input', row), val = $('b', row);
  const set = (n) => { range.value = n; val.textContent = radiusLabel(n); applyRadius(n); pushSettings({ radius: +n }); };
  range.value = state.settings.radius;
  val.textContent = radiusLabel(state.settings.radius);
  range.oninput = () => set(range.value);
  range.onchange = () => range.blur(); // 松手后失焦，让界面按最新设置重绘
  for (const [name, n] of RADIUS_PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset' + (+state.settings.radius === n ? ' current' : '');
    b.textContent = name;
    b.onclick = () => { set(n); Sound.tick(); };
    $('.presets', row).appendChild(b);
  }
  return row;
}

// ---------- 任务栏小组件设置 ----------
const BAR_SEGS = [
  ['widgetPlace', '放在哪块空白', [['auto', '自动'], ['left', '靠左'], ['right', '靠右']], '居中的任务栏左右各有一块空白；自动 = 选能放下更完整形态的那块'],
  ['widgetCollapse', '空间不足时', [['badge', '折叠成徽标'], ['hide', '隐藏']], '空白太窄放不下时的处理'],
  ['widgetAutoHide', '任务栏自动隐藏时', [['follow', '跟随弹出'], ['hide', '不显示']], '开了"自动隐藏任务栏"：跟随 = 任务栏弹出时才出现'],
];
const BAR_SLIDERS = [
  ['widgetGap', '与图标的间距', 0, 24, 1, (n) => n + 'px'],
  ['widgetMaxWidth', '最大宽度', 320, 1200, 20, (n) => n + 'px'],
  ['widgetRotateSec', '轮换间隔', 3, 60, 1, (n) => n + ' 秒'],
];
const EDGE_NAMES = { top: '顶部', bottom: '底部', left: '左侧', right: '右侧' };
const MODE_NAMES = { expanded: '展开任务卡片', compact: '紧凑', badge: '徽标' };
const SIDE_NAMES = { left: '左', right: '右', mid: '中' };
let barTimer = null;

function describeBar(i) {
  if (!i || i.source === 'none') return '没能读到任务栏上的图标位置，小组件使用紧凑形态，可以直接在任务栏上拖动它。';
  const lines = [`${EDGE_NAMES[i.edge] || ''}任务栏 · ${i.source === 'msaa' ? '经典任务栏' : 'Win11 任务栏'}`];
  if (i.systemAlign) lines.push(`系统设置：图标${i.systemAlign === 'left' ? '居左' : '居中'}`);
  lines.push('空白：' + (i.gaps.length ? i.gaps.map((g) => `${SIDE_NAMES[g.side]} ${g.width}px`).join(' / ') : '没有'));
  lines.push('当前：' + (MODE_NAMES[i.mode] || '已隐藏（任务栏上没有空位）') + (i.side ? `，放在${SIDE_NAMES[i.side]}侧` : ''));
  if (i.fellBack) lines.push('指定的一侧放不下，已改用另一侧');
  if (i.autoHide) lines.push(`任务栏自动隐藏中（${i.revealed ? '已弹出' : '已收起'}）`);
  return lines.join('\n');
}

async function refreshBarInfo() {
  const el = $('.bar-info');
  if (el) el.textContent = describeBar(await window.api.widgetInfo());
}

function renderBarMenu() {
  const menu = $('#barMenu');
  const s = state.settings;
  menu.innerHTML = '<div class="title">TASKBAR // 任务栏小组件</div>';

  for (const [key, label] of [['widget', '在任务栏显示小组件'], ['widgetExpand', '空间够时显示任务项'], ['widgetRotate', '自动轮换任务显示']]) {
    const b = document.createElement('button');
    b.className = 'toggle-row' + (s[key] ? ' on' : '');
    b.innerHTML = '<span></span><i class="sw"></i>';
    b.firstChild.textContent = label;
    b.onclick = () => window.api.setSettings({ [key]: !s[key] });
    menu.appendChild(b);
  }

  for (const [key, label, opts, hint] of BAR_SEGS) {
    const row = document.createElement('div');
    row.className = 'seg-row';
    row.innerHTML = '<div class="seg-label"></div><div class="seg"></div>';
    $('.seg-label', row).textContent = label;
    row.title = hint;
    for (const [value, text] of opts) {
      const b = document.createElement('button');
      b.className = s[key] === value ? 'current' : '';
      b.textContent = text;
      b.onclick = () => window.api.setSettings({ [key]: value });
      $('.seg', row).appendChild(b);
    }
    menu.appendChild(row);
  }

  for (const [key, label, min, max, step, fmt] of BAR_SLIDERS) {
    const row = document.createElement('div');
    row.className = 'slider-row';
    row.innerHTML = `<span></span><input type="range" min="${min}" max="${max}" step="${step}"><b></b>`;
    if (key === 'widgetRotateSec') { row.classList.toggle('off', !s.widgetRotate); row.title = '自动轮换开着时才生效；鼠标停在小组件上、或刚手动选过任务时会暂停'; }
    $('span', row).textContent = label;
    const range = $('input', row), val = $('b', row);
    range.value = s[key];
    val.textContent = fmt(s[key]);
    range.oninput = () => { val.textContent = fmt(range.value); pushSettings({ [key]: +range.value }); };
    range.onchange = () => range.blur();
    menu.appendChild(row);
  }

  const info = document.createElement('div');
  info.className = 'bar-info';
  menu.appendChild(info);
  refreshBarInfo();
}

function openBarMenu() {
  $('#skinMenu').classList.remove('open');
  renderBarMenu();
  $('#barMenu').classList.add('open');
  clearInterval(barTimer);
  barTimer = setInterval(refreshBarInfo, 1000);
}

function closeBarMenu() {
  $('#barMenu').classList.remove('open');
  clearInterval(barTimer);
}

// ---------- 渲染 ----------
function taskEl(task) {
  const li = document.createElement('li');
  li.className = 'task';
  li.dataset.id = task.id;
  li.draggable = true;
  // .hit 是比方框大得多的点击热区（整条左侧高度），.check 只负责画方框
  li.innerHTML = '<span class="hit" title="完成"><span class="check"></span></span><span class="text"></span><button class="del" title="删除">✕</button>';
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
  const open = $('#skinMenu.open') || $('#barMenu.open') || $('#drawer.open');
  $('#skinMenu').classList.remove('open');
  closeBarMenu();
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
    if (e.target.closest('.hit')) completeTask(li);
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
    closeBarMenu();
    renderSkinMenu();
    $('#skinMenu').classList.toggle('open');
  };
  $('#btnBar').onclick = (e) => {
    e.stopPropagation();
    if ($('#barMenu').classList.contains('open')) closeBarMenu();
    else openBarMenu();
  };
  window.api.onOpenBar(openBarMenu); // 托盘菜单里的"小组件设置…"
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
    if (!e.target.closest('#barMenu')) closeBarMenu();
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
  let slideTimer = null;
  window.api.onShown(({ edge, focusInput, token }) => {
    renderStatus(); // 跨天后刷新统计
    // 从任务栏所在的那一边滑出
    const app = $('#app');
    const slideClasses = ['from-top', 'from-bottom', 'from-left', 'from-right'];
    app.classList.remove(...slideClasses);
    void app.offsetWidth;
    app.classList.add('from-' + (edge || 'bottom'));
    // 不依赖 animationend：动画被卡住时也保证清掉动画类
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => app.classList.remove(...slideClasses), 450);
    // 下一帧回报"画出来了"；主进程超时没收到就判定为黑块，会强制重绘或重载页面
    requestAnimationFrame(() => window.api.shownAck(token));
    if (focusInput) input.select();
    input.focus();
  });
  input.focus();
  window.api.panelReady(); // 监听都注册好了，主进程这时才开始监测"面板有没有画出来"
}

init();
