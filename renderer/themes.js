// 主题 = 配色；皮肤 = UI 风格（形状、字体、装饰）。两者可以任意组合。
// 想加新主题，照着 THEMES 的格式再写一项；想加新皮肤，在 SKINS 里登记，
// 再到各页面的 css 里写 :root[data-skin="名字"] 开头的样式。

// bg/panel/line 等是界面底色，q1~q4 是四个象限的指示色。
window.THEMES = {
  steel: {
    name: '钢铁灰',
    vars: {
      bg: '#1a1c1f', bg2: '#22252a', panel: '#272a30', panel2: '#2e3239',
      line: '#3a3f47', line2: '#4a505a', text: '#d6dae0', dim: '#7c8591',
      accent: '#ff8a1f', q1: '#ff4d3d', q2: '#ffb020', q3: '#2ad4ff', q4: '#8c96a0',
      hazard: '#ff8a1f', glow: '0.55',
    },
  },
  coolant: {
    name: '冷却液',
    vars: {
      bg: '#0f141b', bg2: '#141b24', panel: '#18212c', panel2: '#1e2936',
      line: '#2a3848', line2: '#3a4d63', text: '#cfe6ff', dim: '#6c87a3',
      accent: '#36c6ff', q1: '#ff5277', q2: '#ffc04a', q3: '#36c6ff', q4: '#7d93ab',
      hazard: '#36c6ff', glow: '0.65',
    },
  },
  hazard: {
    name: '警戒黄',
    vars: {
      bg: '#121212', bg2: '#181818', panel: '#1e1e1e', panel2: '#262626',
      line: '#333333', line2: '#4d4d4d', text: '#f2f2f2', dim: '#8a8a8a',
      accent: '#ffd400', q1: '#ff3b30', q2: '#ffd400', q3: '#ffffff', q4: '#808080',
      hazard: '#ffd400', glow: '0.5',
    },
  },
  alu: {
    name: '铝板',
    vars: {
      bg: '#c9ccd0', bg2: '#d4d7db', panel: '#dfe1e4', panel2: '#e8eaec',
      line: '#a9adb3', line2: '#8e939a', text: '#23262b', dim: '#5f656e',
      accent: '#e8590c', q1: '#d9381e', q2: '#d98c00', q3: '#0a84c6', q4: '#6b7280',
      hazard: '#e8590c', glow: '0.15',
    },
  },
};

window.SKINS = {
  industrial: { name: '工业', desc: '网格 · 警示条 · 角标 · 扫描线' },
  minimal: { name: '极简', desc: '圆角卡片 · 无装饰 · 柔和' },
  hud: { name: '战术 HUD', desc: '切角面板 · 发光描边 · 读数' },
};

window.applyLook = (s) => {
  const theme = THEMES[s.theme] || THEMES.steel;
  for (const [k, v] of Object.entries(theme.vars)) document.documentElement.style.setProperty('--' + k, v);
  document.documentElement.dataset.skin = SKINS[s.skin] ? s.skin : 'industrial';
};
