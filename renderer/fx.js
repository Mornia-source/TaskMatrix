// 完成任务时的粒子爆炸 / 飘字 / 横幅
window.FX = (() => {
  const canvas = document.getElementById('fx');
  const g = canvas.getContext('2d');
  const textLayer = document.getElementById('fxText');
  let parts = [];
  let running = false;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  function loop() {
    g.clearRect(0, 0, innerWidth, innerHeight);
    parts = parts.filter((p) => p.life > 0);
    for (const p of parts) {
      p.vy += p.grav;
      p.vx *= 0.97; p.vy *= 0.97;
      p.x += p.vx; p.y += p.vy;
      p.rot += p.vr;
      p.life -= p.decay;
      g.globalAlpha = Math.max(0, p.life);
      g.fillStyle = p.color;
      g.strokeStyle = p.color;
      if (p.kind === 'spark') {
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(p.x, p.y);
        g.lineTo(p.x - p.vx * 3, p.y - p.vy * 3);
        g.stroke();
      } else if (p.kind === 'ring') {
        p.r += (p.maxR - p.r) * 0.18;
        g.lineWidth = 2 * p.life;
        g.beginPath();
        g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        g.stroke();
      } else {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        g.restore();
      }
    }
    g.globalAlpha = 1;
    if (parts.length) requestAnimationFrame(loop);
    else running = false;
  }

  function kick() {
    if (!running) { running = true; requestAnimationFrame(loop); }
  }

  function burst(x, y, color, power = 1) {
    const n = Math.round(28 * power);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = (2 + Math.random() * 5) * Math.sqrt(power);
      parts.push({
        kind: Math.random() < 0.55 ? 'spark' : 'chip',
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 1.5,
        grav: 0.18, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4,
        size: 2 + Math.random() * 3.5, life: 1, decay: 0.014 + Math.random() * 0.02,
        color: Math.random() < 0.8 ? color : '#ffffff',
      });
    }
    parts.push({ kind: 'ring', x, y, r: 2, maxR: 34 * power, life: 1, decay: 0.045, vx: 0, vy: 0, grav: 0, rot: 0, vr: 0, color });
    kick();
  }

  // 全屏礼花，用于清空所有任务 / 升级
  function shower(colors) {
    for (let i = 0; i < 140; i++) {
      parts.push({
        kind: Math.random() < 0.4 ? 'spark' : 'chip',
        x: Math.random() * innerWidth, y: -10 - Math.random() * 80,
        vx: (Math.random() - 0.5) * 2, vy: 2 + Math.random() * 4,
        grav: 0.06, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
        size: 3 + Math.random() * 4, life: 1, decay: 0.006 + Math.random() * 0.008,
        color: colors[i % colors.length],
      });
    }
    kick();
  }

  function floatText(x, y, text, color) {
    const el = document.createElement('div');
    el.className = 'float-text';
    el.textContent = text;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.setProperty('--qc', color);
    textLayer.appendChild(el);
    setTimeout(() => el.remove(), 1200);
  }

  function banner(title, sub) {
    const el = document.createElement('div');
    el.className = 'banner';
    el.textContent = title;
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      el.appendChild(s);
    }
    textLayer.appendChild(el);
    setTimeout(() => el.remove(), 1400);
  }

  return { burst, shower, floatText, banner };
})();
