// 自绘托盘右键菜单：跟随主题与皮肤；内容由主进程在打开时推送
const $ = (s) => document.querySelector(s);
let st = null;

const Q_NAMES = { 1: '紧急·重要', 2: '重要·不紧急', 3: '紧急·不重要', 4: '不紧急·不重要' };

function renderTask() {
  const t = st.task;
  $('#taskHead').className = 'task-head q' + t.q;
  $('#taskQ').textContent = 'Q' + t.q + ' · ' + Q_NAMES[t.q];
  $('#taskText').textContent = t.text;
  $('#moves').replaceChildren(...[1, 2, 3, 4].map((q) => {
    const b = document.createElement('button');
    b.className = 'mv q' + q + (q === t.q ? ' current' : '');
    b.textContent = 'Q' + q;
    b.title = Q_NAMES[q];
    b.disabled = q === t.q;
    b.onclick = () => window.api.menuAction('task-move', { id: t.id, q });
    return b;
  }));
}

function renderPick() {
  const p = st.pick;
  $('#pickPart').className = 'pick-part q' + p.q;
  $('#pickQ').textContent = `Q${p.q} · ${Q_NAMES[p.q]} · ${p.tasks.length} 项`;
  $('#pickReset').hidden = !p.hasPins;
  $('#pickList').replaceChildren(...p.tasks.map((t) => {
    const row = document.createElement('div');
    row.className = 'pick-row' + (t.current ? ' current' : '') + (t.shown ? ' shown' : '');
    row.innerHTML = '<span class="t"></span><span class="tags"></span><button class="ck" title="直接完成">✓</button>';
    row.querySelector('.t').textContent = t.text; // 注意：这个页面的 $ 只在整个文档里找，行内元素要用 row.querySelector
    row.title = t.text;
    const tags = [];
    if (t.pinned) tags.push('固定');
    if (t.current) tags.push('当前'); else if (t.shown) tags.push('显示中');
    row.querySelector('.tags').textContent = tags.join(' · ');
    row.onclick = () => window.api.menuAction('pick-select', t.id);
    row.querySelector('.ck').onclick = (e) => { e.stopPropagation(); window.api.menuAction('task-complete', t.id); };
    return row;
  }));
}
$('#pickReset').onclick = () => window.api.menuAction('pick-reset');

function render() {
  applyLook(st.settings);
  document.body.classList.toggle('pick-mode', !!st.pick);
  document.body.classList.toggle('task-mode', !!st.task);
  if (st.pick) return renderPick();
  if (st.task) return renderTask();
  const c = st.counts;
  $('#counts').innerHTML = [1, 2, 3, 4].map((q) => `<span class="q${q}${c[q] ? '' : ' empty'}"><i></i>${c[q]}</span>`).join('')
    + `<span class="today">今日 ${st.today}</span>`;
  $('#hotkey').textContent = st.hotkey;

  const on = { widget: st.settings.widget, widgetExpand: st.settings.widgetExpand, pin: st.pinned, sound: st.settings.sound, autostart: st.autoStart };
  document.querySelector('[data-action="widgetExpand"]').classList.toggle('disabled', !st.settings.widget);
  for (const el of document.querySelectorAll('.toggle')) el.classList.toggle('on', !!on[el.dataset.action]);

  $('#themes').replaceChildren(...Object.entries(THEMES).map(([key, t]) => {
    const b = document.createElement('button');
    b.className = 'theme' + (key === st.settings.theme ? ' current' : '');
    b.title = t.name;
    b.style.background = t.vars.bg;
    b.innerHTML = [t.vars.q1, t.vars.q2, t.vars.q3, t.vars.accent].map((col) => `<i style="background:${col}"></i>`).join('');
    b.onclick = () => window.api.menuAction('theme', key);
    return b;
  }));

  // 圆角预设：只有极简皮肤才有圆角可调（精确数值在面板的 SKN 里用滑块调）
  $('#radiusGroup').hidden = st.settings.skin !== 'minimal';
  $('#radii').replaceChildren(...[['直角', 0], ['小', 6], ['默认', 12], ['大', 18]].map(([name, n]) => {
    const b = document.createElement('button');
    b.className = 'skin' + (+st.settings.radius === n ? ' current' : '');
    b.textContent = name;
    b.onclick = () => window.api.menuAction('radius', n);
    return b;
  }));

  $('#skins').replaceChildren(...Object.entries(SKINS).map(([key, s]) => {
    const b = document.createElement('button');
    b.className = 'skin' + (key === st.settings.skin ? ' current' : '');
    b.textContent = s.name;
    b.title = s.desc;
    b.onclick = () => window.api.menuAction('skin', key);
    return b;
  }));
}

document.querySelectorAll('.item[data-action]').forEach((el) => el.addEventListener('click', () => {
  const toggled = el.classList.contains('toggle') ? !el.classList.contains('on') : undefined;
  window.api.menuAction(el.dataset.action, toggled);
}));
document.querySelectorAll('.item[data-task]').forEach((el) => el.addEventListener('click', () => {
  window.api.menuAction(el.dataset.task, st.task.id);
}));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.api.menuAction('close'); });
document.addEventListener('contextmenu', (e) => e.preventDefault());

window.api.onMenuOpen((state) => {
  st = state;
  render();
  // 等样式生效后量高度，主进程据此摆放并显示菜单。
  // 注意不能用 requestAnimationFrame：窗口隐藏时它不会触发，菜单就再也弹不出来
  setTimeout(() => {
    const m = $('#menu');
    m.classList.remove('enter');
    void m.offsetWidth;
    m.classList.add('enter');
    window.api.menuReady(m.getBoundingClientRect().height + 8);
  }, 0);
});
window.api.onSettingsChanged((s) => { if (st) { st.settings = s; if (!st.task && !st.pick) render(); else applyLook(s); } });
window.api.onPinChanged((v) => { if (st) { st.pinned = v; render(); } });
