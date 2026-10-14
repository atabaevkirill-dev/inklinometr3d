/* Физическая модель («железо»): опоры-актуаторы, неровный пол, нагрузка,
 * податливость опор, плита, инклинометры, датчик высоты.
 * Контроллер не имеет доступа к этим данным напрямую — только через measure().
 */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});
  const DEG = Math.PI / 180;
  const G = 9.81;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const quantize = (v, q) => Math.round(v / q) * q;

  function inv3(m) {
    const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-9) throw new Error('Вырожденная геометрия опор (точки на одной прямой)');
    return [
      [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
      [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
      [C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
    ];
  }

  // Геометрия треугольника опор: плоскость через 3 точки и барицентрические веса.
  function supportGeometry(supports) {
    const Minv = inv3(supports.map((s) => [1, s.x, s.y]));
    return {
      Minv,
      // веса λ: значение в точке (x, y) = Σ λi·zi; Σλ = 1; λ < 0 — точка вне треугольника
      bary(x, y) {
        return [0, 1, 2].map((i) => Minv[0][i] + x * Minv[1][i] + y * Minv[2][i]);
      },
      // плоскость z = c + a·x + b·y через три точки опоры
      fitPlane(z) {
        const r = [0, 1, 2].map((k) => Minv[k][0] * z[0] + Minv[k][1] * z[1] + Minv[k][2] * z[2]);
        return { c: r[0], a: r[1], b: r[2] };
      }
    };
  }

  // Детерминированный ГСЧ (mulberry32) — сценарии воспроизводимы.
  class Rng {
    constructor(seed) {
      this.s = seed >>> 0 || 1;
      this.spare = null;
    }
    next() {
      let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    uniform(a, b) {
      return a + (b - a) * this.next();
    }
    gauss() {
      if (this.spare !== null) {
        const s = this.spare;
        this.spare = null;
        return s;
      }
      let u, v, r;
      do {
        u = this.next() * 2 - 1;
        v = this.next() * 2 - 1;
        r = u * u + v * v;
      } while (r >= 1 || r === 0);
      const m = Math.sqrt((-2 * Math.log(r)) / r);
      this.spare = v * m;
      return u * m;
    }
  }

  class Plant {
    constructor(cfg, seed = 1) {
      this.cfg = cfg;
      this.rng = new Rng(seed);
      this.geo = supportGeometry(cfg.supports);
      this.lambda0 = this.geo.bary(0, 0); // центр масс плиты
      this.t = 0;
      this.floor = [0, 0, 0]; // неровность пола под каждой опорой, мм
      this.payload = { mass: 0, x: 0, y: 0 };
      this.hasHeightSensor = !cfg.heightSensor || cfg.heightSensor.noise !== null;
      this.sensorNoise = cfg.sensor.noiseDeg;
      this.tempC = 20;      // температура среды; инклинометры откалиброваны при 20 °C
      this.sensorTempC = 20; // температура самих датчиков — догоняет среду с τ ≈ 90 с
      this.powered = true;  // питание приводов (снимается при аварии / аварийном стопе)
      // pos — положение со стороны мотора (его видит энкодер), ext — фактический выход штока
      this.act = cfg.supports.map(() => ({ pos: 0, ext: 0, vel: 0, cmd: 0, gainErr: 0, force: 0, stalled: false }));
      this.sensors = cfg.sensors.map(() => ({ bias: [0, 0], tc: [0, 0], fault: 'none', drift: [0, 0], frozen: null, last: [0, 0] }));
      this._sampleSensorErrors();
      this.defl = [0, 0, 0];
      this.deflTarget = [0, 0, 0];
      this._updateLoads();
      this.defl = this.deflTarget.slice();
      this._updateGeometry();
    }

    // смещение нуля и температурный коэффициент каждого инклинометра (по классу датчика)
    _sampleSensorErrors() {
      const S = this.cfg.sensor;
      for (const s of this.sensors) {
        s.bias = [this.rng.gauss() * S.biasDeg, this.rng.gauss() * S.biasDeg];
        s.tc = [this.rng.gauss() * (S.tempCoef || 0), this.rng.gauss() * (S.tempCoef || 0)];
      }
    }

    // вызывается после смены железа в конфиге
    onHardwareChanged() {
      this.sensorNoise = this.cfg.sensor.noiseDeg;
      this.hasHeightSensor = !this.cfg.heightSensor || this.cfg.heightSensor.noise !== null;
      this._sampleSensorErrors();
      this._updateLoads();
      this._updateGeometry();
    }

    // ---------- возмущения ----------
    randomizeFloor(amp) {
      this.floor = this.floor.map(() => this.rng.uniform(-amp, amp));
      this._updateGeometry();
    }
    randomizeMotors(spread) {
      for (const a of this.act) a.gainErr = this.rng.uniform(-spread, spread);
    }
    settle(i, mm) {
      this.floor[i] -= mm;
      this._updateGeometry();
    }
    setPayload(mass, x, y) {
      this.payload = { mass, x, y };
      this._updateLoads();
    }
    setSensorFault(j, fault) {
      const s = this.sensors[j], r = this.rng, sgn = () => (r.next() < 0.5 ? -1 : 1);
      s.fault = fault;
      s.drift = [0, 0];
      s.frozen = null;
      // у каждого датчика своя величина и знак отказа (одинаковые отказы двух датчиков маловероятны)
      s.off = [sgn() * r.uniform(0.4, 1.0), sgn() * r.uniform(0.3, 0.8)];
      s.driftDir = [sgn() * r.uniform(0.6, 1.4), sgn() * r.uniform(0.4, 1.0)];
    }
    setCommands(cmd) {
      for (let i = 0; i < 3; i++) this.act[i].cmd = cmd[i] || 0;
    }

    // ---------- динамика ----------
    _updateLoads() {
      const lp = this.geo.bary(this.payload.x, this.payload.y);
      const mp = this.cfg.platform.mass, k = this.cfg.actuator.stiffness;
      this.loadLambda = lp;
      for (let i = 0; i < 3; i++) {
        // 3 опоры — статически определимая система: нагрузка делится по барицентрическим весам
        const F = G * (mp * this.lambda0[i] + this.payload.mass * lp[i]);
        this.act[i].force = F;
        this.deflTarget[i] = F / k;
      }
    }

    step(dt) {
      const A = this.cfg.actuator;
      for (const a of this.act) {
        let vT = this.powered ? clamp(a.cmd, -A.vMax, A.vMax) * (1 + a.gainErr) : 0;
        if (A.vMin && Math.abs(a.cmd) < A.vMin) vT = 0; // трение покоя: команда меньше vMin не сдвигает привод
        a.stalled = this.powered && a.force > A.maxForce && vT > 0;
        if (a.stalled) vT = 0;
        a.vel += clamp(vT - a.vel, -A.aMax * dt, A.aMax * dt);
        // утечки гидравлики и обратный ход ШВП без тормоза: шток уходит вниз пропорционально нагрузке
        let creep = 0;
        if (A.leak) creep += A.leak * (a.force / 1000);
        if (A.backdrive && !this.powered) creep += A.backdrive * (a.force / 1000);
        a.pos += (a.vel - creep) * dt;
        if (a.pos < 0) {
          a.pos = 0;
          if (a.vel < 0) a.vel = 0;
        }
        if (a.pos > A.stroke) {
          a.pos = A.stroke;
          if (a.vel > 0) a.vel = 0;
        }
        // люфт: под нагрузкой на сжатие шток «сидит» на нижнем витке, на растяжение — на верхнем
        a.ext = a.pos - ((A.backlash || 0) / 2) * Math.tanh(a.force / 200);
      }
      const kd = dt / (0.1 + dt); // просадка под нагрузкой устанавливается за ~0.1 с
      for (let i = 0; i < 3; i++) this.defl[i] += (this.deflTarget[i] - this.defl[i]) * kd;
      for (const s of this.sensors) {
        if (s.fault === 'drift') {
          const dir = s.driftDir || [1, -0.6];
          s.drift[0] += dir[0] * this.cfg.sensor.driftRate * dt;
          s.drift[1] += dir[1] * this.cfg.sensor.driftRate * dt;
        }
      }
      this.sensorTempC += ((this.tempC - this.sensorTempC) * dt) / (90 + dt);
      this.t += dt;
      this._updateGeometry();
    }

    _updateGeometry() {
      const A = this.cfg.actuator, T = this.cfg.platform.thickness, half = this.cfg.platform.size / 2;
      const z = this.act.map((a, i) => this.floor[i] + A.bodyLength + a.ext - this.defl[i]);
      this.supportZ = z;
      const p = (this.plane = this.geo.fitPlane(z)); // нижняя плоскость плиты
      this.tiltX = Math.atan(p.a) / DEG;
      this.tiltY = Math.atan(p.b) / DEG;
      this.heightCenter = p.c + T * Math.sqrt(1 + p.a * p.a + p.b * p.b); // верх плиты в центре
      let lo = Infinity, hi = -Infinity;
      for (const [x, y] of [[-half, -half], [half, -half], [half, half], [-half, half]]) {
        const d = p.a * x + p.b * y;
        lo = Math.min(lo, d);
        hi = Math.max(hi, d);
      }
      this.cornerSpread = hi - lo; // перепад высот между углами плиты, мм
    }

    // ---------- датчики ----------
    measure() {
      const C = this.cfg;
      return {
        t: this.t,
        enc: this.act.map((a) => quantize(a.pos, C.actuator.encoderRes)),
        incl: this.sensors.map((s) => this._readInclinometer(s)),
        height: this.hasHeightSensor ? this.heightCenter + this.rng.gauss() * (C.heightSensor.noise || 0) : null
      };
    }

    _readInclinometer(s) {
      const S = this.cfg.sensor;
      if (s.fault === 'dead') return { ok: false, x: NaN, y: NaN };
      if (s.fault === 'stuck') {
        if (!s.frozen) s.frozen = s.last.slice();
        return { ok: true, x: s.frozen[0], y: s.frozen[1] };
      }
      const sigma = s.fault === 'noisy' ? Math.max(0.15, 40 * this.sensorNoise) : this.sensorNoise;
      const dT = this.sensorTempC - 20;
      let x = this.tiltX + s.bias[0] + s.tc[0] * dT + s.drift[0] + sigma * this.rng.gauss();
      let y = this.tiltY + s.bias[1] + s.tc[1] * dT + s.drift[1] + sigma * this.rng.gauss();
      if (s.fault === 'offset') {
        const o = s.off || [0.8, -0.5];
        x += o[0];
        y += o[1];
      }
      x = clamp(quantize(x, S.resolutionDeg), -S.rangeDeg, S.rangeDeg);
      y = clamp(quantize(y, S.resolutionDeg), -S.rangeDeg, S.rangeDeg);
      s.last = [x, y];
      return { ok: true, x, y };
    }
  }

  LP.math = { DEG, G, clamp, quantize, inv3, Rng, supportGeometry };
  LP.Plant = Plant;
})(typeof window !== 'undefined' ? window : globalThis);
