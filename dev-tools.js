// 开发用测试工具：只在设置了 TM_SNAPSHOT / TM_STRESS / TM_PICKTEST 环境变量时由 main.js 加载，不随安装包发布。
// 它们在真实窗口上模拟点击、截屏、压测，用来复现和验证"闪烁 / 黑屏 / 下拉替换 / 轮换"这类只在真实桌面上才会出现的问题。
// 用法见各函数上方的注释；main.js 通过上下文对象 c 把需要的内部状态交过来（会被重新赋值的变量用 getter 保持最新）。
const fs = require('fs');
const path = require('path');
const { app, screen } = require('electron');

module.exports = (c) => {
  const { win, widget, menu, tray, showWindow, send, broadcast, menuState, updateSettings, getTaskbar, isFullscreenBusy, uiaActive } = c;

  // 开发用：TM_SNAPSHOT=目录 时把三个窗口各截一张图，并打印渲染进程日志
  function devSnapshot() {
    const dir = process.env.TM_SNAPSHOT;
    for (const [name, w] of [['panel', win], ['widget', widget], ['menu', menu]]) {
      w.webContents.on('console-message', (e) => console.log(`[${name}]`, e.message));
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    setTimeout(async () => {
      // 测试窗口拿不到焦点时面板会因失焦自动收起，截图前先钉住并显示
      c.setPinned(true); showWindow(); await wait(500);
      // TM_LOOK=皮肤,主题：只在内存里切换外观，不写入用户设置
      if (process.env.TM_LOOK) {
        const [skin, theme] = process.env.TM_LOOK.split(',');
        c.data.settings = { ...c.settings(), skin, theme };
        broadcast('settings-changed', c.data.settings);
        await wait(500);
      }
      // TM_OPEN=Skin / Bar：先在面板里点开对应的弹层再截图
      if (process.env.TM_OPEN) {
        await win.webContents.executeJavaScript(`document.querySelector('#btn${process.env.TM_OPEN}').click()`);
        await wait(900);
      }
      console.log('widget info', JSON.stringify(c.widgetInfo), 'bounds', JSON.stringify(widget.getBounds()), 'visible', widget.isVisible());
      console.log('uia helper active', uiaActive(), 'app path', app.getAppPath());
      console.log('taskbar', JSON.stringify(getTaskbar(screen.getPrimaryDisplay())), 'fullscreenBusy', isFullscreenBusy());
      // 小组件和菜单是透明窗口，capturePage 截不出来，只截面板；另两个用屏幕截图检查
      try {
        fs.writeFileSync(path.join(dir, 'panel.png'), (await win.webContents.capturePage()).toPNG());
      } catch (err) {
        console.log('panel capture failed:', err.message);
      }
      c.setMenuAt({ x: 1500, y: 30 });
      send(menu, 'menu-open', menuState());
      await wait(600);
      for (const [name, w] of [['panel', win], ['widget', widget], ['menu', menu]]) {
        console.log(name, JSON.stringify(w.getBounds()), 'visible', w.isVisible());
      }
      // 菜单反复开关自检（曾经出现过只能打开一次的问题）
      for (let i = 1; i <= 3; i++) {
        menu.hide();
        await wait(1500);
        c.setMenuAt({ x: 1500, y: 30 });
        send(menu, 'menu-open', menuState());
        await wait(500);
        console.log(`menu reopen #${i} visible`, menu.isVisible());
      }
      console.log('widget layout', JSON.stringify(c.widgetLayout && { ...c.widgetLayout.bounds, mode: c.widgetLayout.mode }));
      console.log('widget items', await widget.webContents.executeJavaScript(
        "JSON.stringify([...document.querySelectorAll('.item')].map(e => (e.hidden ? '(hidden) ' : '') + e.textContent).concat(document.querySelector('#more').hidden ? [] : [document.querySelector('#more').textContent]))"));
      // 任务菜单
      menu.hide();
      await wait(300);
      const first = c.data.tasks.find((t) => !t.done);
      c.setMenuAt({ x: 900, y: 30 });
      send(menu, 'menu-open', { ...menuState(), task: first });
      await wait(600);
      console.log('task menu visible', menu.isVisible(), JSON.stringify(menu.getBounds()));
      if (process.env.TM_CLICK) {
        // 模拟在小组件上勾选第一条任务，确认面板（隐藏状态）能完成并回写
        menu.hide();
        const before = c.data.tasks.filter((t) => !t.done).length;
        await widget.webContents.executeJavaScript("document.querySelector('.item .check').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, button: 0, pointerId: 1})); document.querySelector('#bar').dispatchEvent(new PointerEvent('pointerup', {bubbles: true, button: 0, pointerId: 1}))");
        await wait(400);
        process.env.TM_GRAB_NOW && console.log('GRAB_NOW');
        await wait(1600);
        console.log('open tasks before', before, 'after', c.data.tasks.filter((t) => !t.done).length, 'xp', c.data.stats.xp, 'panel visible', win.isVisible());
      }
      if (process.env.TM_HIT) {
        const probe = (w, sel, extra) => w.webContents.executeJavaScript(`(() => {
          const li = document.querySelector('${sel}'); if (!li) return 'no item';
          const h = li.querySelector('.hit').getBoundingClientRect(), c = li.querySelector('.check').getBoundingClientRect(), r = li.getBoundingClientRect();
          const at = (x, y) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('.hit')); };
          return JSON.stringify({ skin: document.documentElement.dataset.skin, check: [c.width, c.height].map(Math.round), hit: [h.width, h.height].map(Math.round), item: [r.width, r.height].map(Math.round),
            cornerTL: at(h.left + 2, h.top + 2), cornerBR: at(h.right - 2, h.bottom - 2), justRightOfHit: at(h.right + 3, h.top + h.height / 2) ${extra} });
        })()`);
        console.log('panel hit', await probe(win, '.task', ''));
        console.log('widget hit', await probe(widget, '.item', ''));
        // 在热区边角（不是方框上）点一下，确认真的会完成任务
        const before = c.data.tasks.filter((t) => !t.done).length;
        await win.webContents.executeJavaScript(`(() => { const h = document.querySelector('.task .hit').getBoundingClientRect(); document.elementFromPoint(h.left + 2, h.bottom - 2).click(); })()`);
        await wait(1500);
        console.log('panel corner click: open', before, '->', c.data.tasks.filter((t) => !t.done).length);
        const before2 = c.data.tasks.filter((t) => !t.done).length;
        // 卡片是圆角，角上不属于卡片，所以点热区靠左边缘的中点（离方框 4px 以外的地方）
        await widget.webContents.executeJavaScript(`(() => { const h = document.querySelector('.item .hit').getBoundingClientRect(); const e = document.elementFromPoint(h.left + 4, h.top + h.height / 2); e.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 })); document.querySelector('#bar').dispatchEvent(Object.assign(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerId: 1 }), {})); })()`);
        await wait(2500);
        console.log('widget: open', before2, '->', c.data.tasks.filter((t) => !t.done).length);
      }
      console.log('snapshot done');
    }, 2000);
  }

  // ---------- 开发用压测（TM_STRESS=panel | widget），用来复现并验证"闪烁 / 黑屏"类问题 ----------
  async function devStress(kind) {
    const { desktopCapturer } = require('electron');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // 截一块真实屏幕区域（desktopCapturer 拿到的是系统合成后的画面，窗口显示成黑块时这里也是黑的），返回亮度均值和标准差
    const grab = async (rect) => {
      const d = screen.getPrimaryDisplay();
      const sf = d.scaleFactor;
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) } });
      const crop = srcs[0].thumbnail.crop({ x: Math.round(rect.x * sf), y: Math.round(rect.y * sf), width: Math.round(rect.width * sf), height: Math.round(rect.height * sf) });
      const bm = crop.toBitmap();
      let n = 0, sum = 0, sum2 = 0;
      for (let i = 0; i < bm.length; i += 28) { const l = 0.114 * bm[i] + 0.587 * bm[i + 1] + 0.299 * bm[i + 2]; n++; sum += l; sum2 += l * l; }
      const mean = sum / n;
      return { mean: Math.round(mean), sd: Math.round(Math.sqrt(Math.max(0, sum2 / n - mean * mean)) * 10) / 10 };
    };

    if (kind === 'panel') {
      c.setPinned(true);
      while (!c.panelReady) await wait(50); // 等页面初始化完再开始压测
      if (process.env.TM_FIRST_WAIT) { // 隐藏启动（开机自启）后，等一段时间再第一次显示
        await wait(Number(process.env.TM_FIRST_WAIT) * 1000);
        showWindow(tray.getBounds());
        await wait(700);
        const s0 = await grab(win.getBounds());
        console.log('stress first-show: 等待', process.env.TM_FIRST_WAIT + 's', 'sd', s0.sd, s0.sd < 4 ? '空白' : '正常');
        app.quit();
        return;
      }
      const idles = [150, 400, 800, 1500, 3000, 200, 600, 1200];
      const results = [];
      for (let i = 0; i < Number(process.env.TM_CYCLES || 30); i++) {
        win.hide();
        await wait(idles[i % idles.length]);
        showWindow(tray.getBounds());
        await wait(700);
        const s = await grab(win.getBounds());
        results.push({ i, idle: idles[i % idles.length], ...s, blank: s.sd < 4 });
      }
      if (process.env.TM_LONG_IDLE) { // 长时间隐藏后再显示
        win.hide(); await wait(Number(process.env.TM_LONG_IDLE) * 1000);
        showWindow(tray.getBounds()); await wait(700);
        const s = await grab(win.getBounds());
        results.push({ i: 'long', idle: process.env.TM_LONG_IDLE + 's', ...s, blank: s.sd < 4 });
      }
      console.log('stress ack 耗时(ms)', JSON.stringify(c.ackLatency), '超过300ms的次数', c.ackLatency.filter((v) => v > 300).length, '没回报的次数', c.showAt.size, '没回报的序号', JSON.stringify([...c.showAt.keys()]));
      console.log('stress panel: 次数', results.length, '空白次数', results.filter((r) => r.blank).length);
      console.log('stress panel 明细(sd 越小越接近空白)', JSON.stringify(results.map((r) => r.sd)));
      app.quit();
    }

    if (kind === 'widget') {
      const zo = require('./win-zorder');
      await wait(3000);
      const hwnd = widget.getNativeWindowHandle();
      const spans = [];
      for (let i = 0; i < 12; i++) {
        await wait(500 + Math.random() * 700);
        zo.raiseTaskbar();
        const t0 = Date.now();
        while (zo.taskbarAbove(hwnd) && Date.now() - t0 < 3000) await wait(4);
        spans.push(Date.now() - t0);
      }
      console.log('stress widget: 被任务栏盖住的时长(ms)', JSON.stringify(spans), '平均', Math.round(spans.reduce((a, b) => a + b, 0) / spans.length), '最长', Math.max(...spans));
      app.quit();
    }
  }

  // ---------- 开发用功能测试（TM_PICKTEST=1）：在真实任务栏上模拟点击，检查"同色任务下拉 / 替换显示 / 轮换 / 空象限" ----------
  async function devPickTest() {
    const { desktopCapturer } = require('electron');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const js = (w, code) => w.webContents.executeJavaScript(code);
    const log = (...a) => console.log('PICKTEST', ...a);
    const dir = process.env.TM_PICKTEST_DIR;
    const shot = async (name, rect) => {
      const d = screen.getPrimaryDisplay();
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: d.size.width, height: d.size.height } });
      const c = srcs[0].thumbnail.crop({ x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.round(rect.width), height: Math.round(rect.height) });
      fs.writeFileSync(path.join(dir, name + '.png'), c.toPNG());
    };
    const click = (sel) => `(() => { const e = document.querySelector('${sel}'); const o = { bubbles: true, button: 0, pointerId: 1 }; e.dispatchEvent(new PointerEvent('pointerdown', o)); document.querySelector('#bar').dispatchEvent(new PointerEvent('pointerup', o)); })()`;
    const cards = () => js(widget, `JSON.stringify([...document.querySelectorAll('#items .item')].filter(e => !e.hidden).map(e => e.querySelector('.t').textContent))`);
    const more = () => js(widget, `document.querySelector('#more').hidden ? '' : document.querySelector('#more').textContent`);
    const barRect = () => { const b = widget.getBounds(); return { x: b.x - 10, y: 0, width: b.width + 20, height: 52 }; };
    const menuRect = () => { const b = menu.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };

    await wait(3500);
    log('1 色块(象限,是否隐藏,数量)', await js(widget, `JSON.stringify([...document.querySelectorAll('.chip')].map(c => [c.dataset.q, c.hidden, c.querySelector('b').textContent]))`));
    log('1 卡片', await cards(), '更多', await more());
    await shot('1-bar', barRect());

    // 2. 点第一张卡片的文字 → 下拉出同色（Q1）的全部任务
    await js(widget, click('#items .item .t'));
    await wait(900);
    log('2 下拉可见', menu.isVisible(), '位置', JSON.stringify(menu.getBounds()), '小组件', JSON.stringify(widget.getBounds()));
    log('2 下拉标题', await js(menu, `document.querySelector('#pickQ').textContent`));
    log('2 下拉行', await js(menu, `JSON.stringify([...document.querySelectorAll('.pick-row')].map(r => r.querySelector('.t').textContent + '|' + r.querySelector('.tags').textContent))`));
    await shot('2-pick', { x: Math.min(widget.getBounds().x, menu.getBounds().x) - 10, y: 0, width: Math.max(widget.getBounds().width, menu.getBounds().width) + 40, height: menu.getBounds().y + menu.getBounds().height + 10 });

    // 3. 选第 3 条（原本排在第三，用来替换第一张）→ 它钉到最前
    await js(menu, `document.querySelectorAll('.pick-row')[2].click()`);
    await wait(900);
    log('3 钉住', JSON.stringify(c.data.widgetPins), '下拉已关', !menu.isVisible());
    log('3 卡片', await cards());
    await shot('3-after-pick', barRect());

    // 4. 面板保存（旧副本）不能把钉住的顺序冲掉
    await js(win, `window.api.save(state)`);
    await wait(500);
    log('4 面板保存后钉住', JSON.stringify(c.data.widgetPins));

    // 5. 点 Q3 计数块 → 同色列表里有"恢复自动顺序"；点它 → 清空钉住
    await js(widget, click('.chip[data-q="3"]'));
    await wait(900);
    log('5 Q3 下拉', await js(menu, `document.querySelector('#pickQ').textContent`), '恢复按钮可见', await js(menu, `!document.querySelector('#pickReset').hidden`));
    await js(menu, `document.querySelector('#pickReset').click()`);
    await wait(800);
    log('5 恢复后钉住', JSON.stringify(c.data.widgetPins), '卡片', await cards());

    // 6. 再钉一个，然后在下拉列表里直接把它完成：钉住记录应自动清除
    await js(widget, click('#items .item .t'));
    await wait(800);
    const pickedId = await js(menu, `(() => { const r = document.querySelectorAll('.pick-row')[1]; r.click(); return r.querySelector('.t').textContent; })()`);
    await wait(700);
    log('6 钉住了', pickedId, JSON.stringify(c.data.widgetPins));
    await js(widget, click('#items .item .t'));
    await wait(800);
    await js(menu, `document.querySelector('.pick-row .ck').click()`); // 第一行是被钉住的那条
    await wait(1800);
    log('6 完成后钉住', JSON.stringify(c.data.widgetPins), '待办数', c.data.tasks.filter((t) => !t.done).length);

    // 7. 自动轮换（紧凑形态：每次换一条）
    await js(widget, 'pauseUntil = 0'); // 前面几步手动选过任务，会暂停轮换 30 秒；测试里直接清掉
    updateSettings({ widgetRotate: true, widgetRotateSec: 3, widgetExpand: false });
    await wait(1500);
    const seq = [];
    for (let i = 0; i < 14; i++) { seq.push(await js(widget, `document.querySelector('#focusText').textContent`)); await wait(1000); }
    log('7 紧凑轮换(每秒采样)', JSON.stringify(seq));
    // 鼠标停在小组件上时暂停
    await js(widget, `document.querySelector('#bar').dispatchEvent(new PointerEvent('pointerenter'))`);
    const held = [];
    for (let i = 0; i < 7; i++) { held.push(await js(widget, `document.querySelector('#focusText').textContent`)); await wait(1000); }
    log('7 悬停时(应不变)', JSON.stringify([...new Set(held)]));
    await js(widget, `document.querySelector('#bar').dispatchEvent(new PointerEvent('pointerleave'))`);

    // 8. 展开形态轮换：放不下的卡片整页翻
    updateSettings({ widgetExpand: true });
    await wait(1500);
    const pages = [];
    for (let i = 0; i < 14; i++) { pages.push((JSON.parse(await cards())[0] || '') + ' +' + (await more())); await wait(1000); }
    log('8 展开轮换(首张卡片 +隐藏数)', JSON.stringify(pages));

    // 9. 关掉轮换：不再变化
    updateSettings({ widgetRotate: false });
    await wait(1500);
    const off = [];
    for (let i = 0; i < 6; i++) { off.push(await js(widget, `document.querySelector('#items .item .t')?.textContent`)); await wait(1000); }
    log('9 关闭轮换后(应不变)', JSON.stringify([...new Set(off)]));
    log('done');
    app.quit();
  }

  // TM_AUTOHIDE=1：面板每次显示 2 秒后自动收起，配合外部脚本用真实鼠标反复点击小组件
  function devAutoHide() { win.on('show', () => setTimeout(() => { if (win.isVisible()) win.hide(); }, 2000)); }

  // TM_RECTS_FILE=文件：每 0.4 秒把小组件里各可点击元素的屏幕坐标写进文件，供外部脚本用真实鼠标去点
  function devRects(file) {
    setInterval(async () => {
      try {
        const wb = widget.getBounds();
        const r = await widget.webContents.executeJavaScript(`(() => {
          const o = {}; const f = (k, s) => { const e = document.querySelector(s); if (!e || e.hidden || !e.offsetWidth) return; const b = e.getBoundingClientRect(); o[k] = [b.left, b.top, b.width, b.height]; };
          f('check', '#items .item:not([hidden]) .hit'); f('text', '#items .item:not([hidden]) .t'); f('chip', '.chip:not([hidden])'); f('add', '#add');
          o.cards = document.querySelectorAll('#items .item:not([hidden])').length; return JSON.stringify(o); })()`);
        fs.writeFileSync(file, JSON.stringify({ wb, r: JSON.parse(r), at: Date.now() }));
      } catch { /* 页面正在重载时读不到，下一轮再写 */ }
    }, 400);
  }

  // TM_HANGTEST=1：人为把主面板的页面卡死 6 秒，再从任务栏小组件上点 ✓ 完成任务，检查操作能否恢复并最终生效
  async function devHangTest() {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const js = (w, code) => w.webContents.executeJavaScript(code);
    const log = (...a) => console.log('HANGTEST', ...a);
    const open = () => c.data.tasks.filter((t) => !t.done).length;
    const clickCheck = `(() => { const e = document.querySelector('#items .item .hit'); const o = { bubbles: true, button: 0, pointerId: 1 }; e.dispatchEvent(new PointerEvent('pointerdown', o)); document.querySelector('#bar').dispatchEvent(new PointerEvent('pointerup', o)); })()`;
    await wait(3500);

    log('0 正常情况：待办', open());
    let t0 = Date.now(); const n0 = open();
    await js(widget, clickCheck);
    while (open() === n0 && Date.now() - t0 < 5000) await wait(30);
    log('0 正常点 ✓ 生效耗时', Date.now() - t0, 'ms；待办', open());

    log('1 卡死面板页面 6 秒…');
    js(win, '(() => { const t = Date.now(); while (Date.now() - t < 6000) {} })()').catch(() => {});
    await wait(400);
    const n1 = open(); t0 = Date.now();
    await js(widget, clickCheck);
    while (open() === n1 && Date.now() - t0 < 20000) await wait(50);
    log('1 页面卡死时点 ✓：', open() < n1 ? '最终生效' : '没有生效', '，耗时', Date.now() - t0, 'ms；待办', open());
    await wait(1500);

    log('2 页面恢复后再点一次：');
    const n2 = open(); t0 = Date.now();
    await js(widget, clickCheck);
    while (open() === n2 && Date.now() - t0 < 5000) await wait(30);
    log('2 生效耗时', Date.now() - t0, 'ms；待办', open());
    const dl = path.join(app.getPath('userData'), 'debug.log');
    log('debug.log:', fs.existsSync(dl) ? fs.readFileSync(dl, 'utf8').trim().split('\n').slice(-4).join(' | ') : '(无)');
    log('done');
    app.quit();
  }

  // TM_BLOCKTEST=标记文件：面板刚被显示的同一时刻，把主进程的界面线程堵死 11 秒，用来看窗口会变成什么样（对照用户的黑屏截图）
  async function devBlockTest(markerFile) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(4500);
    win.hide(); await wait(1200);
    showWindow(tray.getBounds());
    fs.writeFileSync(markerFile, JSON.stringify({ panel: win.getBounds(), pid: process.pid, at: Date.now() }));
    const t = Date.now(); while (Date.now() - t < 11000) { /* 主进程界面线程被占住 */ }
    console.log('BLOCKTEST 解除');
    await wait(2500);
    app.quit();
  }

  // TM_GPUTEST=标记文件 [TM_GPUMODE=hidden|visible]：把 GPU 进程杀掉（模拟显卡驱动重置 / GPU 崩溃），在 hidden 模式下之后再显示面板，
  // visible 模式下是面板显示着的时候杀；写出面板坐标给外部脚本截图，看窗口会变成什么样
  async function devGpuTest(markerFile, mode) {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const killGpu = () => {
      if (mode.startsWith('renderer')) { const pid = win.webContents.getOSProcessId(); process.kill(pid); return pid; } // 杀掉主面板页面自己的渲染进程
      const g = app.getAppMetrics().find((m) => m.type === 'GPU'); if (g) process.kill(g.pid); return g && g.pid;
    };
    c.setPinned(true); // 测试进程拿不到焦点，别让它因失焦自动收起
    await wait(4500);
    let killed;
    if (mode === 'visible' || mode === 'renderer-visible') { showWindow(tray.getBounds()); await wait(1200); killed = killGpu(); await wait(300); }
    else { win.hide(); await wait(1000); killed = killGpu(); await wait(900); showWindow(tray.getBounds()); }
    fs.writeFileSync(markerFile, JSON.stringify({ panel: win.getBounds(), killed, mode, at: Date.now() }));
    if (process.env.TM_GPUDIAG) { await wait(1500); const f = await c.dumpDiagnostics('测试：' + mode, true); console.log('DIAGFILE', f); }
    await wait(11000);
    console.log('GPUTEST 结束；GPU 进程被杀的 pid', killed);
    app.quit();
  }

  // TM_DIAG=1：正常状态下保存一份诊断快照并打印出来，检查内容是否完整
  async function devDiag() {
    await new Promise((r) => setTimeout(r, 5000));
    const f = await c.dumpDiagnostics('测试：正常状态', true);
    console.log('DIAGFILE', f);
    app.quit();
  }

  return { devSnapshot, devStress, devPickTest, devAutoHide, devRects, devHangTest, devBlockTest, devGpuTest, devDiag };
};
