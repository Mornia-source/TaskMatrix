// 用 WebAudio 现场合成音效，不依赖音频文件
window.Sound = (() => {
  let ctx = null;
  let enabled = true;

  const ac = () => (ctx ||= new AudioContext());

  function tone(freq, start, dur, type = 'square', vol = 0.08) {
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, c.currentTime + start);
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(vol, c.currentTime + start + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + start);
    o.stop(c.currentTime + start + dur + 0.02);
  }

  // 机械"咔哒"：一小段滤波噪声 + 低频冲击
  function clunk(start = 0, vol = 0.25) {
    const c = ac();
    const len = Math.floor(c.sampleRate * 0.06);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.8;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(f).connect(g).connect(c.destination);
    src.start(c.currentTime + start);

    const o = c.createOscillator();
    const og = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, c.currentTime + start);
    o.frequency.exponentialRampToValueAtTime(45, c.currentTime + start + 0.12);
    og.gain.setValueAtTime(vol * 1.2, c.currentTime + start);
    og.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + 0.15);
    o.connect(og).connect(c.destination);
    o.start(c.currentTime + start);
    o.stop(c.currentTime + start + 0.2);
  }

  return {
    setEnabled(v) { enabled = v; },
    add() {
      if (!enabled) return;
      tone(660, 0, 0.05); tone(990, 0.045, 0.07);
    },
    remove() {
      if (!enabled) return;
      tone(300, 0, 0.08, 'sawtooth', 0.05); tone(180, 0.06, 0.1, 'sawtooth', 0.05);
    },
    // combo 越高音调越高
    complete(quadrant, combo) {
      if (!enabled) return;
      clunk(0);
      const base = [0, 523.25, 440, 392, 329.63][quadrant] * Math.pow(2, Math.min(combo - 1, 8) / 12);
      [1, 1.25, 1.5, 2].forEach((m, i) => tone(base * m, 0.06 + i * 0.055, 0.12, 'square', 0.06));
    },
    levelUp() {
      if (!enabled) return;
      [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, i * 0.07, 0.18, 'triangle', 0.1));
    },
    allClear() {
      if (!enabled) return;
      clunk(0, 0.35);
      [392, 523, 659, 784, 1046].forEach((f, i) => tone(f, 0.1 + i * 0.09, 0.3, 'square', 0.05));
    },
    tick() {
      if (!enabled) return;
      tone(1200, 0, 0.02, 'square', 0.03);
    },
  };
})();
