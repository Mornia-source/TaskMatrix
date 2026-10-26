const test = require('node:test');
const assert = require('node:assert/strict');
const { pickSlot, freeGaps, EXPANDED_MIN, HYSTERESIS } = require('../taskbar-layout');

// 一排图标：起点、个数、每个宽度、间距
const icons = (from, n, w = 52, gap = 4) => Array.from({ length: n }, (_, i) => [from + i * (w + gap), from + i * (w + gap) + w]);
const BAR = { start: 0, end: 1920 };

test('经典任务栏（StartAllBack）：一块空白，靠托盘一侧，宽度受最大宽度限制', () => {
  const r = pickSlot({ ...BAR, occupied: [[0, 469], [1407, 1920]] });
  assert.equal(r.mode, 'expanded');
  assert.equal(r.side, 'right');
  assert.equal(r.x1, 1407 - 8);
  assert.equal(r.x1 - r.x0, 760);
});

test('Win11 居左：开始和图标贴左，空白在右', () => {
  const occupied = [[0, 48], ...icons(52, 8), [1500, 1920]]; // 小组件按钮 + 开始/搜索/应用 + 托盘
  const gaps = freeGaps(BAR.start, BAR.end, occupied);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].side, 'right');
  const r = pickSlot({ ...BAR, occupied });
  assert.equal(r.mode, 'expanded');
  assert.ok(r.x0 >= 52 + 8 * 56 && r.x1 <= 1500, '不能压到图标和托盘');
});

test('Win11 居中：左右各有一块空白，两侧都能展开时选靠托盘的右侧', () => {
  const occupied = [[0, 48], ...icons(800, 6), [1580, 1920]]; // 图标簇 800~1128；左空白 48~800，右空白 1128~1580
  const gaps = freeGaps(BAR.start, BAR.end, occupied);
  assert.deepEqual(gaps.map((g) => g.side), ['left', 'right']);
  const r = pickSlot({ ...BAR, occupied });
  assert.equal(r.side, 'right');
  assert.equal(r.mode, 'expanded');
  assert.ok(r.x0 >= 1128 + 8 && r.x1 <= 1580 - 8);
});

test('居中但右侧放不下展开形态：自动改用能展开的左侧，而不是在右侧缩成紧凑', () => {
  const occupied = [[0, 48], ...icons(800, 6), [1500, 1920]]; // 右空白 372（< 展开门槛）
  const r = pickSlot({ ...BAR, occupied });
  assert.equal(r.side, 'left');
  assert.equal(r.mode, 'expanded');
  assert.equal(r.anchor, 'start');
  assert.equal(r.x0, 48 + 8);
  // 指定靠右就尊重，用紧凑形态
  const right = pickSlot({ ...BAR, occupied, prefs: { place: 'right' } });
  assert.equal(right.side, 'right');
  assert.equal(right.mode, 'compact');
});

test('居中且右侧只剩一点点：自动改用更宽的左侧', () => {
  const occupied = [[0, 48], ...icons(1150, 6), [1560, 1920]]; // 右空白只剩约 78
  const r = pickSlot({ ...BAR, occupied });
  assert.equal(r.side, 'left');
});

test('指定靠左 / 靠右；指定侧放不下时退到另一侧而不是消失', () => {
  const occupied = [[0, 48], ...icons(800, 6), [1500, 1920]];
  assert.equal(pickSlot({ ...BAR, occupied, prefs: { place: 'left' } }).side, 'left');
  assert.equal(pickSlot({ ...BAR, occupied, prefs: { place: 'right' } }).side, 'right');
  const tinyRight = [[0, 48], ...icons(1150, 6), [1520, 1920]]; // 右侧只剩约 38，连徽标都放不下
  const r = pickSlot({ ...BAR, occupied: tinyRight, prefs: { place: 'right' } });
  assert.equal(r.side, 'left');
  assert.equal(r.fellBack, true);
  // 右侧还能放徽标时，尊重"靠右"的选择，不抢着换到左边
  const badgeRight = [[0, 48], ...icons(1150, 6), [1560, 1920]];
  const k = pickSlot({ ...BAR, occupied: badgeRight, prefs: { place: 'right' } });
  assert.equal(k.side, 'right');
  assert.equal(k.mode, 'badge');
});

test('空间越小形态越简化：展开 → 紧凑 → 徽标 → 隐藏', () => {
  const at = (room, prefs) => pickSlot({ ...BAR, occupied: [[0, 600], [600 + room + 16, 1920]], prefs }).mode;
  assert.equal(at(400), 'expanded');
  assert.equal(at(200), 'compact');
  assert.equal(at(100), 'badge');
  assert.equal(at(30), null);
  assert.equal(at(100, { collapse: 'hide' }), null, '选择"空间不足时隐藏"就不要徽标');
  assert.equal(at(400, { expand: false }), 'compact', '关掉"显示任务项"就不展开');
});

test('参数生效：间距、最大宽度', () => {
  const occupied = [[0, 469], [1407, 1920]];
  const a = pickSlot({ ...BAR, occupied, prefs: { gap: 0, maxWidth: 400 } });
  assert.equal(a.x1, 1407);
  assert.equal(a.x1 - a.x0, 400);
  const b = pickSlot({ ...BAR, occupied, prefs: { gap: 24 } });
  assert.equal(b.x1, 1407 - 24);
});

test('图标之间的小缝隙不算空白', () => {
  assert.equal(freeGaps(0, 1000, [[0, 100], [104, 200], [206, 1000]]).length, 0);
});

test('滞回：临界宽度附近不会来回跳形态', () => {
  const room = (n) => pickSlot({ ...BAR, occupied: [[0, 600], [600 + n + 16, 1920]], prev: 'compact' }).mode;
  assert.equal(room(EXPANDED_MIN + 5), 'compact', '刚过门槛但还没多出滞回量，维持紧凑');
  assert.equal(room(EXPANDED_MIN + HYSTERESIS + 1), 'expanded');
  const down = pickSlot({ ...BAR, occupied: [[0, 600], [600 + EXPANDED_MIN - 2 + 16, 1920]], prev: 'expanded' });
  assert.equal(down.mode, 'compact', '低于门槛立刻降级');
});

test('自动隐藏：收起时几乎整个在屏幕外，弹出后完整可见', () => {
  const { visibleRatio } = require('../taskbar-layout');
  const screen = { left: 0, top: 0, right: 1920, bottom: 1080 };
  assert.ok(visibleRatio({ left: 0, top: -46, right: 1920, bottom: 2 }, screen) < 0.1, '顶部收起');
  assert.ok(visibleRatio({ left: 0, top: 1078, right: 1920, bottom: 1126 }, screen) < 0.1, '底部收起');
  assert.ok(visibleRatio({ left: -46, top: 0, right: 2, bottom: 1080 }, screen) < 0.1, '左侧收起');
  assert.equal(visibleRatio({ left: 0, top: 0, right: 1920, bottom: 48 }, screen), 1, '弹出');
  assert.equal(visibleRatio({ left: 0, top: 0, right: 0, bottom: 0 }, screen), 0, '无效矩形');
});

test('任务栏被图标占满：没有空白时返回 null', () => {
  assert.equal(pickSlot({ ...BAR, occupied: [[0, 1920]] }).mode, null);
});
