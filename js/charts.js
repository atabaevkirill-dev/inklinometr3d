/* Лёгкие графики на canvas: временные ряды (в т.ч. симметрично-логарифмическая шкала) и пузырьковый уровень. */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});

  const COL = { grid: '#1d2633', zero: '#33414f', text: '#8b98a8', band: 'rgba(61,220,132,0.13)', bandLine: 'rgba(61,220,132,0.5)' };

  function setup(c) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = c.clientWidth, H = c.clientHeight;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    return { g, W, H };
  }

  function niceStep(span, n) {
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }

  function fmtTick(v, step) {
    const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    return Math.abs(v) < step / 1e6 ? '0' : v.toFixed(Math.min(d, 4));
  }

  class TimeChart {
    constructor(canvas, opts) {
      this.c = canvas;
      this.o = Object.assign({ window: 60, minSpan: 1, symmetric: false, symlog: 0, digits: 1, series: [], band: null }, opts);
    }

    draw(hist, tNow) {
      const { g, W, H } = setup(this.c);
      if (W < 40 || H < 40) return;
      const o = this.o, L = 46, R = 8, Tp = 20, B = 16, pw = W - L - R, ph = H - Tp - B;
      const t1 = Math.max(o.window, tNow), t0 = t1 - o.window;
      let i0 = hist.length;
      while (i0 > 0 && hist[i0 - 1].t >= t0) i0--;
      const pts = i0 > 0 ? hist.slice(i0 - 1) : hist;

      const lin = (v) => v;
      const slog = (v) => Math.sign(v) * Math.log10(1 + Math.abs(v) / o.symlog);
      const tf = o.symlog ? slog : lin;

      let lo = Infinity, hi = -Infinity;
      for (const h of pts) {
        for (const s of o.series) {
          const v = s.get(h);
          if (Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
      if (!Number.isFinite(lo)) {
        lo = -o.minSpan / 2;
        hi = o.minSpan / 2;
      }
      const band = o.band ? o.band() : 0;
      if (o.symmetric) {
        const m = Math.max(Math.abs(lo), Math.abs(hi), o.minSpan / 2, band * 1.5);
        lo = -m;
        hi = m;
      } else if (hi - lo < o.minSpan) {
        const mid = (hi + lo) / 2;
        lo = mid - o.minSpan / 2;
        hi = mid + o.minSpan / 2;
      }
      let ylo = tf(lo), yhi = tf(hi);
      const pad = (yhi - ylo) * 0.08;
      ylo -= pad;
      yhi += pad;
      const X = (t) => L + ((t - t0) / (t1 - t0)) * pw;
      const Y = (v) => Tp + (1 - (tf(v) - ylo) / (yhi - ylo)) * ph;

      g.font = '10px system-ui, -apple-system, sans-serif';
      g.textBaseline = 'middle';

      // сетка и подписи оси значений
      let ticks = [];
      if (o.symlog) {
        ticks.push(0);
        for (let d = o.symlog; d <= Math.max(Math.abs(lo), Math.abs(hi)) * 1.0001; d *= 10) ticks.push(d, -d);
      } else {
        const st = niceStep(hi - lo, 4);
        for (let v = Math.ceil(lo / st) * st; v <= hi + st * 1e-6; v += st) ticks.push(v);
        ticks.step = st;
      }
      g.textAlign = 'right';
      for (const v of ticks) {
        const y = Y(v);
        if (y < Tp - 1 || y > Tp + ph + 1) continue;
        g.strokeStyle = v === 0 ? COL.zero : COL.grid;
        g.beginPath();
        g.moveTo(L, y);
        g.lineTo(L + pw, y);
        g.stroke();
        g.fillStyle = COL.text;
        g.fillText(o.symlog ? (v === 0 ? '0' : String(+v.toPrecision(2))) : fmtTick(v, ticks.step), L - 5, y);
      }
      // ось времени, шаг 10 с
      g.textAlign = 'center';
      for (let t = Math.ceil(t0 / 10) * 10; t <= t1; t += 10) {
        const x = X(t);
        g.strokeStyle = COL.grid;
        g.beginPath();
        g.moveTo(x, Tp);
        g.lineTo(x, Tp + ph);
        g.stroke();
        g.fillStyle = COL.text;
        g.fillText(t + ' с', x, H - 7);
      }

      g.save();
      g.beginPath();
      g.rect(L, Tp, pw, ph);
      g.clip();
      if (band > 0) {
        const ya = Y(band), yb = Y(-band);
        g.fillStyle = COL.band;
        g.fillRect(L, ya, pw, yb - ya);
        g.strokeStyle = COL.bandLine;
        g.setLineDash([3, 3]);
        g.beginPath();
        g.moveTo(L, ya);
        g.lineTo(L + pw, ya);
        g.moveTo(L, yb);
        g.lineTo(L + pw, yb);
        g.stroke();
      }
      g.lineWidth = 1.6;
      for (const s of o.series) {
        g.strokeStyle = s.color;
        g.setLineDash(s.dash || []);
        g.beginPath();
        let started = false;
        for (const h of pts) {
          const v = s.get(h);
          if (!Number.isFinite(v)) continue;
          const x = X(h.t), y = Y(v);
          if (started) g.lineTo(x, y);
          else {
            g.moveTo(x, y);
            started = true;
          }
        }
        g.stroke();
      }
      g.restore();
      g.setLineDash([]);
      g.lineWidth = 1;

      // легенда с текущими значениями
      const last = pts[pts.length - 1];
      let x = L;
      g.textAlign = 'left';
      g.font = '11px system-ui, -apple-system, sans-serif';
      for (const s of o.series) {
        const v = last ? s.get(last) : NaN;
        const txt = `${s.label} ${Number.isFinite(v) ? v.toFixed(o.digits) : '—'}`;
        g.fillStyle = s.color;
        g.fillRect(x, 6, 10, 3);
        g.fillStyle = '#c9d4df';
        g.fillText(txt, x + 14, 8);
        x += g.measureText(txt).width + 26;
      }
    }
  }

  // Пузырьковый уровень. Пузырёк уходит к высокой стороне: X>0 — вправо, Y>0 — вверх (назад).
  function drawBubble(canvas, tx, ty, tol, valid) {
    const { g, W, H } = setup(canvas);
    const r = Math.min(W, H) / 2 - 8, cx = W / 2, cy = H / 2;
    if (r < 20) return 0;
    const m = Math.max(Math.abs(tx), Math.abs(ty));
    const Rg = [0.05, 0.2, 1, 5].find((x) => m <= x * 0.92) || 5;

    const bg = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    bg.addColorStop(0, '#16202b');
    bg.addColorStop(1, '#0d131a');
    g.fillStyle = bg;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#2a3646';
    for (const k of [0.25, 0.5, 0.75, 1]) {
      g.beginPath();
      g.arc(cx, cy, r * k, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(cx - r, cy);
    g.lineTo(cx + r, cy);
    g.moveTo(cx, cy - r);
    g.lineTo(cx, cy + r);
    g.stroke();

    const rt = (tol / Rg) * r;
    if (rt > 2 && rt < r) {
      g.strokeStyle = 'rgba(61,220,132,0.85)';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.arc(cx, cy, rt, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }

    let bx = (tx / Rg) * r, by = (-ty / Rg) * r;
    const d = Math.hypot(bx, by);
    if (d > r - 9) {
      bx *= (r - 9) / d;
      by *= (r - 9) / d;
    }
    const color = !valid ? '#8b98a8' : m <= tol ? '#3ddc84' : m <= 5 * tol ? '#f5b041' : '#ff5a5f';
    const bub = g.createRadialGradient(cx + bx - 3, cy + by - 3, 1, cx + bx, cy + by, 10);
    bub.addColorStop(0, '#ffffff');
    bub.addColorStop(0.35, color);
    bub.addColorStop(1, color);
    g.fillStyle = bub;
    g.beginPath();
    g.arc(cx + bx, cy + by, 9, 0, Math.PI * 2);
    g.fill();

    g.fillStyle = '#8b98a8';
    g.font = '10px system-ui, -apple-system, sans-serif';
    g.textAlign = 'right';
    g.textBaseline = 'alphabetic';
    g.fillText(`±${Rg}°`, W - 2, H - 3);
    g.textAlign = 'left';
    g.fillText('X →', 2, H - 3);
    g.fillText('↑ Y', 2, 10);
    return Rg;
  }

  LP.TimeChart = TimeChart;
  LP.drawBubble = drawBubble;
})(typeof window !== 'undefined' ? window : globalThis);
