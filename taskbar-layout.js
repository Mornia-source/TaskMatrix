// 任务栏空白区域的布局算法（纯函数，不依赖 Electron，便于测试）
//
// 输入：任务栏沿长边的范围 [start, end]，以及已被占用的区间（开始按钮、应用图标、托盘……）。
// 输出：小组件该放在哪一块空白、占多宽、用哪种形态。
// 所有数值使用同一套单位（调用方统一成 DIP 再传进来）。
//
// 兼容的任务栏排布：
//   居左（经典 / Win11 居左）  [开始 图标 图标 ………… 空白 ………… 托盘]      → 一块空白，靠托盘一侧
//   居中（Win11 默认）         [小组件 …空白… 开始 图标 图标 …空白… 托盘]     → 左右两块空白，可选
// 形态由空白宽度决定：expanded（任务卡片）→ compact（计数 + 最该做的一条）→ badge（单个徽标）→ 隐藏

const EXPANDED_MIN = 400;   // 空白至少这么宽才展开显示任务卡片（计数块、新建按钮、+N 约占 220，剩下的才够放卡片）
const COMPACT_MIN = 150;
const BADGE_MIN = 44;
const BADGE_W = 60;
const COMPACT_W = 300;
const HYSTERESIS = 20;      // 形态要"升级"时需要多出的宽度，避免在临界值附近来回跳
const MAJOR_GAP = 24;       // 小于这个宽度的缝隙当作图标之间的间距，不算空白

const DEFAULT_PREFS = { place: 'auto', gap: 8, maxWidth: 760, collapse: 'badge', expand: true };

const RANK = { expanded: 3, compact: 2, badge: 1 };

function mergeIntervals(list, tol = 1) {
  const sorted = list.filter((r) => r && r[1] > r[0]).map((r) => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + tol) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

// 任务栏上所有空闲区间，只保留够宽的（图标之间的几像素缝隙不算）
function freeGaps(start, end, occupied) {
  const merged = mergeIntervals(occupied.map(([a, b]) => [Math.max(a, start), Math.min(b, end)]));
  const gaps = [];
  let cur = start;
  for (const [a, b] of merged) {
    if (a > cur) gaps.push({ start: cur, end: a });
    cur = Math.max(cur, b);
  }
  if (cur < end) gaps.push({ start: cur, end });
  const major = gaps.filter((g) => g.end - g.start >= MAJOR_GAP).map((g) => ({ ...g, width: g.end - g.start }));
  // 一块空白就是"靠托盘一侧"；两块以上时，第一块在左、最后一块在右
  return major.map((g, i) => ({
    ...g,
    side: major.length === 1 || i === major.length - 1 ? 'right' : i === 0 ? 'left' : 'mid',
  }));
}

// 空白够宽时能进入哪个形态；prev 是上一次的形态，用来做滞回
function tierFor(width, prefs, prev) {
  const tiers = [];
  if (prefs.expand) tiers.push(['expanded', EXPANDED_MIN]);
  tiers.push(['compact', COMPACT_MIN]);
  if (prefs.collapse === 'badge') tiers.push(['badge', BADGE_MIN]);
  for (const [name, min] of tiers) {
    const climbing = prev && (RANK[prev] || 0) < RANK[name];
    if (width >= min + (climbing ? HYSTERESIS : 0)) return name;
  }
  return null;
}

function widthFor(mode, usable, prefs) {
  if (mode === 'expanded') return Math.min(usable, Math.max(prefs.maxWidth, EXPANDED_MIN));
  if (mode === 'compact') return Math.min(usable, COMPACT_W, Math.max(prefs.maxWidth, COMPACT_MIN));
  return BADGE_W;
}

// 选一块空白并算出小组件的位置与形态
// 返回 { mode, x0, x1, side, anchor, fellBack, gaps }；没有合适的空间时 mode 为 null
function pickSlot({ start, end, occupied, prefs: p, prev }) {
  const prefs = { ...DEFAULT_PREFS, ...p };
  const gaps = freeGaps(start, end, occupied);
  const margin = Math.max(0, prefs.gap);

  const cands = gaps.map((g) => {
    const usable = g.width - margin * 2;
    return { ...g, usable, mode: usable > 0 ? tierFor(usable, prefs, prev) : null };
  });
  const viable = cands.filter((c) => c.mode);

  let pick = null;
  let fellBack = false;
  if (prefs.place === 'left' || prefs.place === 'right') {
    pick = viable.find((c) => c.side === prefs.place) || null;
    if (!pick && viable.length) { pick = best(viable); fellBack = true; } // 指定的那侧放不下，退到另一侧，别让小组件消失
  } else {
    pick = best(viable);
  }

  const info = { gaps: cands.map(({ side, start: s, end: e, width, usable, mode }) => ({ side, start: s, end: e, width, usable, mode })) };
  if (!pick) return { mode: null, ...info };

  const width = widthFor(pick.mode, pick.usable, prefs);
  const lo = pick.start + margin;
  const hi = pick.end - margin;
  // 贴着空白的外侧：右侧空白靠托盘，左侧空白靠屏幕边缘。图标增多时空白收缩，小组件不会来回跳
  const anchor = pick.side === 'right' ? 'end' : 'start';
  const x0 = anchor === 'end' ? hi - width : lo;
  return { mode: pick.mode, x0, x1: x0 + width, side: pick.side, anchor, fellBack, ...info };
}

// 任务栏窗口有多大比例还在屏幕里：自动隐藏收起时，任务栏几乎整个移到了屏幕外（只剩约 2px 的感应条）
function visibleRatio(bar, screenRect) {
  const w = Math.min(bar.right, screenRect.right) - Math.max(bar.left, screenRect.left);
  const h = Math.min(bar.bottom, screenRect.bottom) - Math.max(bar.top, screenRect.top);
  const area = (bar.right - bar.left) * (bar.bottom - bar.top);
  return w <= 0 || h <= 0 || area <= 0 ? 0 : (w * h) / area;
}

// 形态等级高的优先；同级时靠托盘的右侧优先，再比宽度
function best(list) {
  return [...list].sort((a, b) =>
    (RANK[b.mode] - RANK[a.mode]) || ((b.side === 'right') - (a.side === 'right')) || (b.usable - a.usable))[0] || null;
}

module.exports = {
  pickSlot, freeGaps, mergeIntervals, tierFor, visibleRatio,
  EXPANDED_MIN, COMPACT_MIN, BADGE_MIN, BADGE_W, COMPACT_W, HYSTERESIS, DEFAULT_PREFS,
};
