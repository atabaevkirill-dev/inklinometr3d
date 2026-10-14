/* Инженерные расчёты: 3 опоры против 4.
 * Плита — тонкая пластина Кирхгофа, МКЭ на прямоугольных элементах ACM (12 степеней свободы:
 * w, ∂w/∂x, ∂w/∂y в узлах). Опоры — пружины с жёсткостью привода. Единицы: мм, Н, МПа, кг.
 */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});
  const G = 9.81, DEG = Math.PI / 180;

  const MATERIALS = {
    al: { name: 'Алюминиевая плита', E: 70000, nu: 0.33, rho: 2.7e-6 },
    steel: { name: 'Стальная плита', E: 210000, nu: 0.3, rho: 7.85e-6 }
  };

  const LAYOUTS = {
    tri: { name: '3 опоры (как в симуляции)', short: '3 опоры', pts: [[-400, -400], [400, -400], [0, 400]] },
    triEdge: { name: '3 опоры у края плиты', short: '3 у края', pts: [[-475, -475], [475, -475], [0, 475]] },
    quad: { name: '4 опоры', short: '4 опоры', pts: [[-400, -400], [400, -400], [400, 400], [-400, 400]] }
  };

  // ---------- линейная алгебра ----------
  function invDense(M) {
    const n = M.length, A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      const d = A[c][c];
      if (Math.abs(d) < 1e-14) throw new Error('вырожденная матрица');
      for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r][c];
        if (f) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
      }
    }
    return A.map((r) => r.slice(n));
  }

  // Симметричная ленточная матрица (нижняя лента) и разложение Холецкого.
  class Band {
    constructor(n, bw) {
      this.n = n;
      this.bw = bw;
      this.a = new Float64Array(n * (bw + 1));
    }
    idx(i, j) {
      return i * (this.bw + 1) + (j - i + this.bw); // j ≤ i, i − j ≤ bw
    }
    add(i, j, v) {
      if (j > i) [i, j] = [j, i];
      this.a[this.idx(i, j)] += v;
    }
    cholesky() {
      const { n, bw, a } = this, W = bw + 1;
      for (let j = 0; j < n; j++) {
        const j0 = Math.max(0, j - bw);
        let s = a[j * W + bw];
        for (let k = j0; k < j; k++) {
          const l = a[j * W + (k - j + bw)];
          s -= l * l;
        }
        if (s <= 0) throw new Error('матрица жёсткости не положительно определена (мало опор?)');
        const d = Math.sqrt(s);
        a[j * W + bw] = d;
        const iMax = Math.min(n - 1, j + bw);
        for (let i = j + 1; i <= iMax; i++) {
          const k0 = Math.max(0, i - bw);
          let t = a[i * W + (j - i + bw)];
          for (let k = k0; k < j; k++) t -= a[i * W + (k - i + bw)] * a[j * W + (k - j + bw)];
          a[i * W + (j - i + bw)] = t / d;
        }
      }
      return this;
    }
    solve(b) {
      const { n, bw, a } = this, W = bw + 1, x = Float64Array.from(b);
      for (let i = 0; i < n; i++) {
        let s = x[i];
        for (let k = Math.max(0, i - bw); k < i; k++) s -= a[i * W + (k - i + bw)] * x[k];
        x[i] = s / a[i * W + bw];
      }
      for (let i = n - 1; i >= 0; i--) {
        let s = x[i];
        for (let k = i + 1; k <= Math.min(n - 1, i + bw); k++) s -= a[k * W + (i - k + bw)] * x[k];
        x[i] = s / a[i * W + bw];
      }
      return x;
    }
  }

  // ---------- элемент ACM ----------
  const P = (x, y) => [1, x, y, x * x, x * y, y * y, x * x * x, x * x * y, x * y * y, y * y * y, x * x * x * y, x * y * y * y];
  const Px = (x, y) => [0, 1, 0, 2 * x, y, 0, 3 * x * x, 2 * x * y, y * y, 0, 3 * x * x * y, y * y * y];
  const Py = (x, y) => [0, 0, 1, 0, x, 2 * y, 0, x * x, 2 * x * y, 3 * y * y, x * x * x, 3 * x * y * y];
  const Pxx = (x, y) => [0, 0, 0, 2, 0, 0, 6 * x, 2 * y, 0, 0, 6 * x * y, 0];
  const Pyy = (x, y) => [0, 0, 0, 0, 0, 2, 0, 0, 2 * x, 6 * y, 0, 6 * x * y];
  const Pxy = (x, y) => [0, 0, 0, 0, 1, 0, 0, 2 * x, 2 * y, 0, 3 * x * x, 3 * y * y];

  const GP = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)], GW = [5 / 9, 8 / 9, 5 / 9];

  // Квадратный элемент со стороной a, узлы (−h,−h) (h,−h) (h,h) (−h,h). Степени свободы узла: w, w_x, w_y.
  function acmElement(a, Dflex, nu) {
    const h = a / 2, nodes = [[-h, -h], [h, -h], [h, h], [-h, h]];
    const C = [];
    for (const [x, y] of nodes) C.push(P(x, y), Px(x, y), Py(x, y));
    const Ci = invDense(C);
    const D = [[Dflex, Dflex * nu, 0], [Dflex * nu, Dflex, 0], [0, 0, (Dflex * (1 - nu)) / 2]];
    const Ka = Array.from({ length: 12 }, () => new Float64Array(12));
    const Fa = new Float64Array(12);
    for (let gi = 0; gi < 3; gi++) {
      for (let gj = 0; gj < 3; gj++) {
        const x = h * GP[gi], y = h * GP[gj], wgt = GW[gi] * GW[gj] * h * h;
        const B = [Pxx(x, y).map((v) => -v), Pyy(x, y).map((v) => -v), Pxy(x, y).map((v) => -2 * v)];
        for (let p = 0; p < 12; p++) {
          const DBp = [0, 1, 2].map((r) => D[r][0] * B[0][p] + D[r][1] * B[1][p] + D[r][2] * B[2][p]);
          for (let q = 0; q < 12; q++) Ka[q][p] += wgt * (B[0][q] * DBp[0] + B[1][q] * DBp[1] + B[2][q] * DBp[2]);
        }
        const Pv = P(x, y);
        for (let p = 0; p < 12; p++) Fa[p] += wgt * Pv[p];
      }
    }
    // K = Ciᵀ·Ka·Ci, F = Ciᵀ·Fa
    const T = Ka.map((row) => Array.from({ length: 12 }, (_, j) => row.reduce((s, v, k) => s + v * Ci[k][j], 0)));
    const K = Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 }, (_, j) => T.reduce((s, row, k) => s + Ci[k][i] * row[j], 0)));
    const F = Array.from({ length: 12 }, (_, i) => Fa.reduce((s, v, k) => s + Ci[k][i] * v, 0));
    return { K, F, Ci, h };
  }

  // ---------- модель плиты на пружинных опорах ----------
  /* opts: { size, t, mat:{E,nu,rho}, n (элементов по стороне), supports:[[x,y],...], k (Н/мм, число или массив),
   *         lineSupports: [{axis:'x', at:±L/2}] — для проверочной задачи } */
  function buildPlate(opts) {
    const { size: L, t, mat, n } = opts;
    const a = L / n, N1 = n + 1, nn = N1 * N1, ndof = 3 * nn;
    const Dflex = (mat.E * t ** 3) / (12 * (1 - mat.nu ** 2));
    const el = acmElement(a, Dflex, mat.nu);
    const bw = 3 * (N1 + 1) + 2;
    const K = new Band(ndof, bw);
    const nodeAt = (x, y) => {
      const i = Math.round((x + L / 2) / a), j = Math.round((y + L / 2) / a);
      if (i < 0 || j < 0 || i > n || j > n) throw new Error(`точка (${x}, ${y}) вне плиты`);
      if (Math.abs(-L / 2 + i * a - x) > 1e-6 || Math.abs(-L / 2 + j * a - y) > 1e-6) throw new Error(`точка (${x}, ${y}) не в узле сетки ${a} мм`);
      return j * N1 + i;
    };
    const Fq = new Float64Array(ndof); // нагрузка от единичного давления (1 Н/мм², вверх)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const p0 = j * N1 + i, ns = [p0, p0 + 1, p0 + N1 + 1, p0 + N1];
        const dofs = [];
        for (const p of ns) dofs.push(3 * p, 3 * p + 1, 3 * p + 2);
        for (let r = 0; r < 12; r++) {
          Fq[dofs[r]] += el.F[r];
          for (let c = 0; c <= r; c++) K.add(dofs[r], dofs[c], el.K[r][c]);
        }
      }
    }
    const sup = (opts.supports || []).map(([x, y], s) => ({ x, y, node: nodeAt(x, y), k: Array.isArray(opts.k) ? opts.k[s] : opts.k }));
    for (const s of sup) K.add(3 * s.node, 3 * s.node, s.k);
    if (opts.lineSupports) {
      for (let j = 0; j < N1; j++) for (const i of [0, n]) K.add(3 * (j * N1 + i), 3 * (j * N1 + i), 1e9);
    }
    K.cholesky();
    const coords = (p) => [-L / 2 + (p % N1) * a, -L / 2 + Math.floor(p / N1) * a];
    return { L, t, a, n, N1, nn, ndof, Dflex, K, Fq, sup, nodeAt, coords, mat };
  }

  // Решение: самовес, сосредоточенные грузы [{x,y,m}], смещения опор delta (мм)
  function solvePlate(pl, { selfWeight = true, points = [], delta = null } = {}) {
    const f = new Float64Array(pl.ndof);
    if (selfWeight) {
      const q = pl.mat.rho * pl.t * G; // Н/мм²
      for (let d = 0; d < pl.ndof; d++) f[d] = -q * pl.Fq[d];
    }
    for (const p of points) {
      for (const { q, wgt } of payloadNodes(pl.L, pl.n, p).nodes) f[3 * q] -= p.m * G * wgt;
    }
    if (delta) pl.sup.forEach((s, i) => (f[3 * s.node] += s.k * (delta[i] || 0)));
    const u = pl.K.solve(f);
    const w = new Float64Array(pl.nn);
    for (let p = 0; p < pl.nn; p++) w[p] = u[3 * p];
    const R = pl.sup.map((s, i) => s.k * ((delta ? delta[i] || 0 : 0) - w[s.node]));
    return { w, R, load: -f.reduce((s, v, d) => (d % 3 === 0 ? s + v : s), 0) };
  }

  /* Узловые веса груза (Σ = 1) и фактический центр нагрузки.
   * Пятно size×size обрезается краем плиты, вес узла — площадь его ячейки под пятном;
   * без пятна — билинейно по 4 ближайшим узлам. */
  function payloadNodes(L, n, p) {
    const a = L / n, N1 = n + 1, h = L / 2, out = [];
    if (!p.size) {
      const x = Math.max(-h, Math.min(h, p.x)), y = Math.max(-h, Math.min(h, p.y));
      const fi = Math.min(n - 1e-9, (x + h) / a), fj = Math.min(n - 1e-9, (y + h) / a);
      const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
      for (const [di, dj, wgt] of [[0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)], [0, 1, (1 - u) * v], [1, 1, u * v]]) {
        if (wgt > 1e-12) out.push({ q: (j + dj) * N1 + (i + di), wgt });
      }
    } else {
      const x0 = Math.max(-h, p.x - p.size / 2), x1 = Math.min(h, p.x + p.size / 2);
      const y0 = Math.max(-h, p.y - p.size / 2), y1 = Math.min(h, p.y + p.size / 2);
      if (x1 <= x0 || y1 <= y0) return payloadNodes(L, n, { ...p, size: 0 });
      let tot = 0;
      for (let j = 0; j <= n; j++) {
        const yc = -h + j * a, oy = Math.min(y1, yc + a / 2, h) - Math.max(y0, yc - a / 2, -h);
        if (oy <= 0) continue;
        for (let i = 0; i <= n; i++) {
          const xc = -h + i * a, ox = Math.min(x1, xc + a / 2, h) - Math.max(x0, xc - a / 2, -h);
          if (ox > 0) {
            out.push({ q: j * N1 + i, wgt: ox * oy });
            tot += ox * oy;
          }
        }
      }
      for (const o of out) o.wgt /= tot;
    }
    let cx = 0, cy = 0;
    for (const { q, wgt } of out) {
      cx += wgt * (-h + (q % N1) * a);
      cy += wgt * (-h + Math.floor(q / N1) * a);
    }
    return { nodes: out, cx, cy };
  }

  // Плоскость наименьших квадратов z = c + a·x + b·y по точкам
  function fitPlane(pts) {
    let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
    for (const [x, y, z] of pts) {
      n++; sx += x; sy += y; sz += z; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z;
    }
    const M = invDense([[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]]);
    const r = [sz, sxz, syz];
    const [c, a, b] = M.map((row) => row[0] * r[0] + row[1] * r[1] + row[2] * r[2]);
    return { c, a, b };
  }

  // Плоскостность: отклонение поверхности от плоскости через опоры и от наилучшей плоскости
  function flatness(pl, w) {
    const sp = fitPlane(pl.sup.map((s) => [s.x, s.y, w[s.node]]));
    const all = [];
    for (let p = 0; p < pl.nn; p++) all.push([...pl.coords(p), w[p]]);
    const bp = fitPlane(all);
    let sMin = Infinity, sMax = -Infinity, bMin = Infinity, bMax = -Infinity;
    for (const [x, y, z] of all) {
      const ds = z - (sp.c + sp.a * x + sp.b * y), db = z - (bp.c + bp.a * x + bp.b * y);
      sMin = Math.min(sMin, ds); sMax = Math.max(sMax, ds);
      bMin = Math.min(bMin, db); bMax = Math.max(bMax, db);
    }
    return { sagMax: -sMin, sagUp: sMax, pv: bMax - bMin };
  }

  // Карты влияния: реакция каждой опоры от единичного груза в каждом узле (теорема взаимности)
  function influence(pl) {
    return pl.sup.map((s) => {
      const e = new Float64Array(pl.ndof);
      e[3 * s.node] = 1;
      const u = pl.K.solve(e);
      const r = new Float64Array(pl.nn);
      for (let p = 0; p < pl.nn; p++) r[p] = s.k * u[3 * p];
      return r; // доля веса груза, приходящаяся на опору (Σ по опорам = 1)
    });
  }

  // ---------- полный расчёт для одной раскладки ----------
  const snap = (v, a) => Math.round(v / a) * a;

  // Центр тяжести «плита + груз» и лучший треугольник опор для него: перебор троек точек
  // по периметру плиты (отступ 25 мм, шаг 50 мм), критерий — максимальный запас от ЦТ до сторон
  function optimalTriangle(P0) {
    const mat = MATERIALS[P0.material], mp = mat.rho * P0.size * P0.size * P0.t, m = P0.payload.m;
    const pc = payloadNodes(P0.size, P0.n, P0.payload);
    const gx = (m * pc.cx) / (mp + m), gy = (m * pc.cy) / (mp + m);
    const lim = P0.size / 2 - 25, cand = [], key = new Set();
    for (let v = -lim; v <= lim + 1e-9; v += 50) {
      for (const p of [[v, -lim], [v, lim], [-lim, v], [lim, v]]) {
        const k = p.join(',');
        if (!key.has(k)) {
          key.add(k);
          cand.push(p);
        }
      }
    }
    // критерий: запас и для плиты с грузом, и для пустой (монтаж); при равенстве — больше площадь
    let best = null, bestM = -Infinity, bestA = 0;
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        for (let k = j + 1; k < cand.length; k++) {
          const tri = [cand[i], cand[j], cand[k]];
          const ar = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
          if (Math.abs(ar) < 1e3) continue;
          const mg = Math.min(insideMargin(tri, gx, gy), insideMargin(tri, 0, 0));
          if (mg > bestM + 0.5 || (mg > bestM - 0.5 && Math.abs(ar) > bestA)) {
            if (mg > bestM) bestM = mg;
            bestA = Math.abs(ar);
            best = tri;
          }
        }
      }
    }
    return { pts: best, gx, gy, margin: insideMargin(best, gx, gy), marginEmpty: insideMargin(best, 0, 0) };
  }

  // Минимальное расстояние от точки до границы выпуклого многоугольника (минус — точка снаружи)
  function insideMargin(poly, x, y) {
    let dIn = Infinity, inside = true, dSeg = Infinity;
    const sgn = Math.sign(poly.reduce((s, [x1, y1], i) => {
      const [x2, y2] = poly[(i + 1) % poly.length];
      return s + x1 * y2 - x2 * y1;
    }, 0));
    poly.forEach(([x1, y1], i) => {
      const [x2, y2] = poly[(i + 1) % poly.length];
      const len = Math.hypot(x2 - x1, y2 - y1);
      const d = (((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) * sgn) / len;
      if (d < 0) inside = false;
      dIn = Math.min(dIn, Math.abs(d));
      // расстояние до отрезка (с учётом концов)
      const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / (len * len)));
      dSeg = Math.min(dSeg, Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))));
    });
    return inside ? dIn : -dSeg;
  }

  function analyze(name, pts, P0) {
    const mat = MATERIALS[P0.material];
    const pl = buildPlate({ size: P0.size, t: P0.t, mat, n: P0.n, supports: pts, k: P0.k });
    const plateMass = mat.rho * P0.size * P0.size * P0.t;
    const py0 = P0.payload, pc = payloadNodes(P0.size, P0.n, py0);
    const py = { ...py0, cx: pc.cx, cy: pc.cy };
    const load = py.m ? [{ x: py.x, y: py.y, m: py.m, size: py.size }] : [];
    const self = solvePlate(pl);
    const loaded = solvePlate(pl, { points: load });
    const flat = flatness(pl, loaded.w);
    const flatSelf = flatness(pl, self.w);
    const inf = influence(pl);
    // сколько ЕЩЁ груза можно поставить в каждую точку поверх вашего без отрыва опор
    const mAllow = new Float64Array(pl.nn);
    let worstAllow = Infinity;
    for (let p = 0; p < pl.nn; p++) {
      let m = Infinity;
      inf.forEach((r, i) => {
        if (loaded.R[i] <= 0) m = 0;
        else if (r[p] < 0) m = Math.min(m, loaded.R[i] / (G * -r[p]));
      });
      mAllow[p] = m;
      worstAllow = Math.min(worstAllow, m);
    }
    // ошибка высоты 1 мм на первой опоре: как перераспределяются нагрузки
    const sens = solvePlate(pl, { selfWeight: false, delta: [1] });
    const plRigid = buildPlate({ size: P0.size, t: P0.t, mat, n: P0.n, supports: pts, k: 1e6 });
    const sensRigid = solvePlate(plRigid, { selfWeight: false, delta: [1] });
    const Rmin = Math.min(...loaded.R);
    const dRmax = Math.max(...sens.R.map(Math.abs));
    // устойчивость: запас ЦТ до края опорного многоугольника и допустимая боковая сила
    const W = (plateMass + py.m) * G;
    const gx = (py.m * py.cx) / (plateMass + py.m), gy = (py.m * py.cy) / (plateMass + py.m);
    const hg = (plateMass * (P0.t / 2) + py.m * (P0.t + py.hc)) / (plateMass + py.m);
    const margin = insideMargin(pts, gx, gy);
    const area = Math.abs(pts.reduce((s, [x, y], i) => {
      const [x2, y2] = pts[(i + 1) % pts.length];
      return s + x * y2 - x2 * y;
    }, 0)) / 2;
    let levers = null;
    if (pts.length === 3) {
      levers = pts.map((s, i) => {
        const o = pts.filter((_, j) => j !== i);
        const dx = o[1][0] - o[0][0], dy = o[1][1] - o[0][1];
        return Math.abs(dx * (o[0][1] - s[1]) - dy * (o[0][0] - s[0])) / Math.hypot(dx, dy);
      });
    }
    return {
      name, pts, pl, plateMass, W, selfR: self.R, R: loaded.R, Rmin, w: loaded.w, flat, flatSelf,
      payloadTilt: py.m ? payloadTilt(pl, loaded.w, pc.nodes) : 0, marginEmpty: insideMargin(pts, 0, 0), payloadCenter: [pc.cx, pc.cy],
      inf, mAllow, worstAllow, sensR: sens.R, sensRigidR: sensRigid.R, dRmax,
      unloadAt: pts.length > 3 && dRmax > 0 ? Rmin / dRmax : Infinity,
      gx, gy, hg, margin, sideForce: margin > 0 ? (W * margin) / hg : 0, areaFrac: area / (P0.size * P0.size), levers
    };
  }

  // Наклон площадки под грузом относительно плоскости опор, ° (опоры выставлены в горизонт —
  // столько и будет наклонён сам груз из-за прогиба плиты)
  function payloadTilt(pl, w, nodes) {
    const sp = fitPlane(pl.sup.map((s) => [s.x, s.y, w[s.node]]));
    const under = nodes.length >= 3 ? nodes : [];
    if (under.length < 3) return 0;
    const pp = fitPlane(under.map(({ q }) => [...pl.coords(q), w[q]]));
    return Math.max(Math.abs(Math.atan(pp.a - sp.a)), Math.abs(Math.atan(pp.b - sp.b))) / DEG;
  }

  // Прогиб (размах от наилучшей плоскости) при разных толщинах плиты
  function thicknessTable(pts, P0, list) {
    return list.map(([material, t]) => {
      const mat = MATERIALS[material];
      const pl = buildPlate({ size: P0.size, t, mat, n: P0.n, supports: pts, k: P0.k });
      const py = P0.payload;
      const r = solvePlate(pl, { points: py.m ? [{ x: py.x, y: py.y, m: py.m, size: py.size }] : [] });
      const tilt = py.m ? payloadTilt(pl, r.w, payloadNodes(P0.size, P0.n, py).nodes) : 0;
      return { material, t, mass: mat.rho * P0.size * P0.size * t, pv: flatness(pl, r.w).pv, tilt };
    });
  }

  // ---------- подбор привода: винтовая пара + редуктор + мотор ----------
  const MOTORS = {
    nema23cl: { name: 'Шаговый NEMA 23 с энкодером (~2.5 Н·м удерж.)', curve: [[0, 2.2], [300, 1.8], [600, 1.3], [1000, 0.8], [1500, 0.5]], stepper: true },
    nema34cl: { name: 'Шаговый NEMA 34 с энкодером (~8.5 Н·м удерж.)', curve: [[0, 7.5], [300, 6], [600, 4.2], [1000, 2.6], [1500, 1.5]], stepper: true },
    servo400: { name: 'Серводвигатель 400 Вт с тормозом (1.27 Н·м ном.)', curve: [[0, 1.27], [3000, 1.27], [4500, 0.8]], stepper: false }
  };
  const torqueAt = (curve, rpm) => {
    for (let i = 1; i < curve.length; i++) {
      if (rpm <= curve[i][0]) {
        const [r0, t0] = curve[i - 1], [r1, t1] = curve[i];
        return t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
      }
    }
    return 0; // выше максимальных оборотов из характеристики мотор не тянет
  };

  // Винтовые пары и передачи (типовые значения; КПД червячной пары зависит от числа заходов — уточнять по каталогу)
  const SCREWS = [
    { id: 'tr20', name: 'трап. винт Tr20×4', screw: 'trap', lead: 4, d2: 18, d3: 15.5 },
    { id: 'tr30', name: 'трап. винт Tr30×6', screw: 'trap', lead: 6, d2: 27, d3: 23 },
    { id: 'ball1605', name: 'ШВП 16×5', screw: 'ball', lead: 5, d2: 16, d3: 12.9 }
  ];
  const RATIOS = [
    { ratio: 5, worm: 0.7, other: 0.95 },
    { ratio: 10, worm: 0.6, other: 0.95 },
    { ratio: 20, worm: 0.45, other: 0.93 }
  ];
  const DRIVES = [];
  for (const sc of SCREWS) {
    for (const r of RATIOS) {
      for (const motor of Object.keys(MOTORS)) {
        const gear = sc.screw === 'trap' ? `червячный редуктор 1:${r.ratio}` : `планетарный редуктор 1:${r.ratio}`;
        DRIVES.push({ ...sc, id: `${sc.id}-${r.ratio}-${motor}`, name: `${sc.name}, ${gear}`, ratio: r.ratio, etaGear: sc.screw === 'trap' ? r.worm : r.other, motor });
      }
    }
  }

  /* opts: F — расчётная нагрузка на опору, Н; v — скорость, мм/с; lever — плечо для угла, мм;
   * stroke — свободная длина винта, мм; K — коэффициент длины (2 — верх свободен вбок, 0.7 — в направляющей) */
  function sizeDrive(d, { F, v, lever, micro = 8, mu = 0.1, stroke = 800, K = 2 }) {
    const lam = Math.atan(d.lead / (Math.PI * d.d2)); // угол подъёма резьбы
    let etaScrew, selfLock, rho = null;
    if (d.screw === 'trap') {
      rho = Math.atan(mu / Math.cos(15 * DEG)); // приведённый угол трения, профиль 30°
      etaScrew = Math.tan(lam) / Math.tan(lam + rho);
      selfLock = lam < rho;
    } else {
      etaScrew = 0.9;
      selfLock = false;
    }
    const eta = etaScrew * d.etaGear;
    const T = (F * d.lead) / 1000 / (2 * Math.PI * eta * d.ratio); // Н·м на валу мотора
    const rpm = (v / d.lead) * d.ratio * 60;
    const mot = MOTORS[d.motor];
    const Tav = torqueAt(mot.curve, rpm);
    const need = mot.stepper ? 2 : 1.3; // запас: шаговому ×2 (пропуск шагов), серво ×1.3
    const stepMm = d.lead / (d.ratio * 200), microMm = stepMm / micro;
    // продольный изгиб винта (Эйлер): Pкр = π²·E·I / (K·L)², I = π·d3⁴/64, запас ≥ 3
    const I = (Math.PI * d.d3 ** 4) / 64, Pcr = (Math.PI ** 2 * 210000 * I) / (K * stroke) ** 2;
    const buckleOk = Pcr / F >= 3;
    // входные обороты червячного домкрата обычно ограничены ~1500 об/мин
    const rpmOk = d.screw !== 'trap' || rpm <= 1500;
    return {
      Pcr, buckleMargin: Pcr / F, buckleOk, rpmOk,
      ...d, motorName: mot.name, lamDeg: lam / DEG, rhoDeg: rho === null ? null : rho / DEG, etaScrew, eta, selfLock,
      T, rpm, Tav, margin: Tav / T, torqueOk: Tav / T >= need, ok: Tav / T >= need && buckleOk && rpmOk, need, power: (T * rpm * 2 * Math.PI) / 60,
      stepMm, microMm, tiltPerMicro: Math.atan(microMm / lever) / DEG,
      holds: selfLock ? 'самоторможение (в статике)' : mot.stepper ? 'нужен тормоз' : 'тормоз мотора',
      stepper: mot.stepper
    };
  }

  // Подбор: годные (запас по моменту) и держащие без питания — сначала; среди них проще и дешевле
  function rankDrives(opts) {
    const cost = { nema23cl: 1, nema34cl: 2, servo400: 3 };
    return DRIVES.map((d) => sizeDrive(d, opts))
      .map((r) => ({ ...r, score: (r.ok ? 0 : 100) + (r.selfLock ? 0 : r.stepper ? 50 : 10) + cost[r.motor] * 3 + (r.screw === 'trap' && r.lead === 6 ? 1 : 0) + Math.abs(Math.log(r.margin / 3)) }))
      .sort((a, b) => a.score - b.score);
  }

  // Кинематика: на сколько сходятся точки крепления при наклоне плиты (нужна подвижность шарниров)
  function kinematics(spanMm, degs) {
    return degs.map((d) => ({ deg: d, shift: spanMm * (1 - Math.cos((d * Math.PI) / 180)), lateral: spanMm * Math.sin((d * Math.PI) / 180) }));
  }

  // Проверка МКЭ точным решением: плита на двух опёртых кромках (ν = 0), цилиндрический изгиб,
  // w = 5·q·L⁴ / (384·D)
  function verifyCylindrical(n) {
    const mat = { E: 70000, nu: 0, rho: 2.7e-6 };
    const pl = buildPlate({ size: 1000, t: 30, mat, n, supports: [], k: 0, lineSupports: true });
    const r = solvePlate(pl);
    const q = mat.rho * 30 * G;
    const exact = (5 * q * 1000 ** 4) / (384 * pl.Dflex);
    const wc = -r.w[pl.nodeAt(0, 0)];
    return { fem: wc, exact, err: wc / exact - 1 };
  }

  LP.calc = {
    MATERIALS, LAYOUTS, MOTORS, DRIVES, buildPlate, solvePlate, flatness, influence, analyze, optimalTriangle,
    thicknessTable, sizeDrive, rankDrives, SCREWS, kinematics, payloadNodes, payloadTilt, verifyCylindrical, fitPlane, insideMargin
  };
})(typeof window !== 'undefined' ? window : globalThis);
