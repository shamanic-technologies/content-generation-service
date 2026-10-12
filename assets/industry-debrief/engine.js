// promo-motion engine: every value is a pure function of time.
// Load before the scene script. The scene must set Motion.T (loop length, seconds)
// before calling any Track.at().
(function () {
  const Motion = {};
  Motion.T = 0;

  // Closed-form damped spring. y = displacement from target, v = velocity.
  function springEval(y0, v0, t, w, z) {
    if (t <= 0) return [y0, v0];
    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z), e = Math.exp(-z * w * t);
      const c = Math.cos(wd * t), s = Math.sin(wd * t), K = (v0 + z * w * y0) / wd;
      return [e * (y0 * c + K * s), e * (-z * w * (y0 * c + K * s) + (-y0 * wd * s + K * wd * c))];
    }
    const e = Math.exp(-w * t), C = v0 + w * y0;
    return [(y0 + C * t) * e, (C - w * (y0 + C * t)) * e];
  }

  // A value that changes target many times. Each segment starts from the exact
  // position + velocity the previous one reached, so it stays continuous and pure.
  //   .to(t, target, omega, zeta)  spring toward target from time t
  //   .fn(t0, t1, f)               direct manipulation: value = f(t) on [t0, t1]
  //                                (put a .to(t1, ...) right after to release it)
  class Track {
    constructor(v) { this.v0 = v; this.s = []; this.sorted = false; this.loop = true; }
    to(t, x, w = 17, z = 0.8) { this.s.push({ t, x, w, z }); this.sorted = false; return this; }
    fn(t0, t1, f) { this.s.push({ t: t0, t1, f }); this.sorted = false; return this; }
    noLoop() { this.loop = false; return this; }
    adv(cur, x, v, tp, t) {
      if (!cur) return [x, v];
      if (cur.f) {
        const tt = Math.min(t, cur.t1);
        const X = cur.f(tt), V = (cur.f(tt) - cur.f(tt - 1e-3)) / 1e-3;
        return t <= cur.t1 ? [X, V] : [X, 0];
      }
      const [y, vv] = springEval(x - cur.x, v, t - tp, cur.w, cur.z);
      return [cur.x + y, vv];
    }
    at(t) {
      if (!this.sorted) { this.s.sort((a, c) => a.t - c.t); this.sorted = true; }
      let x = this.v0, v = 0, tp = -1e9, cur = null;
      for (const sg of this.s) {
        if (sg.t > t) break;
        [x, v] = this.adv(cur, x, v, tp, sg.t);
        cur = sg; tp = sg.t;
      }
      const out = this.adv(cur, x, v, tp, t)[0];
      if (!this.loop || !Motion.T) return out;
      // loop closure: land exactly on the t=0 value at T, so the last frame is the first
      const k = (t - (Motion.T - 0.3)) / 0.3;
      return k > 0 ? out + (this.v0 - out) * (k >= 1 ? 1 : k * k * (3 - 2 * k)) : out;
    }
  }

  const clamp = (x, a, c) => Math.max(a, Math.min(c, x));
  const lerp = (a, c, k) => a + (c - a) * k;
  const smoother = k => { k = clamp(k, 0, 1); return k * k * k * (k * (k * 6 - 15) + 10); };
  const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  function mixHex(a, c, k) {
    const A = rgb(a), C = rgb(c);
    return `rgb(${A.map((v, i) => Math.round(lerp(v, C[i], k))).join(',')})`;
  }
  function mix3(a, c, d, kc, kd) { // a -> c by kc, then -> d by kd
    const A = rgb(a), C = rgb(c), D = rgb(d);
    return `rgb(${A.map((v, i) => Math.round(lerp(lerp(v, C[i], kc), D[i], kd))).join(',')})`;
  }

  // Content layers: each has visibility intervals; enter slower than exit so a
  // swap inside a morphing container never shows two texts at full strength.
  const INF = 1e9;
  const layers = {};
  function layer(id, intervals, enter = [26, 1], exit = [38, 1]) {
    const tr = new Track(intervals[0][0] < -1 ? 1 : 0);
    for (const [a, c] of intervals) {
      if (a > -1) tr.to(a, 1, enter[0], enter[1]);
      if (c < 1e8) tr.to(c, 0, exit[0], exit[1]);
    }
    layers[id] = { tr, el: null, size: [0, 0] };
    return tr;
  }
  function measureLayers() {
    for (const id of Object.keys(layers)) {
      const el = document.getElementById(id);
      layers[id].el = el; layers[id].size = [el.offsetWidth, el.offsetHeight];
    }
  }
  // place a layer so its centre sits at (x, y) in its parent's coordinates
  function place(id, t, x, y, blur = 9) {
    const L = layers[id], v = clamp(L.tr.at(t), 0, 1), el = L.el;
    if (v < 0.004) { el.style.visibility = 'hidden'; return v; }
    el.style.visibility = '';
    const [lw, lh] = L.size, k = 1 - v;
    el.style.opacity = v.toFixed(4);
    el.style.filter = k > 0.002 ? `blur(${(k * blur).toFixed(2)}px)` : 'none';
    el.style.transform = `translate(${(x - lw / 2).toFixed(2)}px,${(y - lh / 2 + k * 10).toFixed(2)}px) scale(${(0.965 + 0.035 * v).toFixed(4)})`;
    return v;
  }
  // same visual treatment for any element driven by a visibility value
  function fade(el, v, dy = 10, blur = 7) {
    v = clamp(v, 0, 1);
    // '' (not 'visible') so a child never overrides a hidden parent layer
    if (v < 0.004) { el.style.visibility = 'hidden'; return; }
    el.style.visibility = '';
    const k = 1 - v;
    el.style.opacity = v.toFixed(4);
    el.style.filter = k > 0.002 ? `blur(${(k * blur).toFixed(2)}px)` : 'none';
    return (k * dy);
  }

  Object.assign(Motion, { springEval, Track, clamp, lerp, smoother, mixHex, mix3, layer, layers, measureLayers, place, fade, INF });
  window.Motion = Motion;
})();
