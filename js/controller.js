/* Контроллер выравнивания. Не зависит от модели: получает только измерения
 * (энкодеры, инклинометры, датчик высоты) и выдаёт команды скорости опорам, мм/с.
 * Эту логику можно один в один перенести на реальный контроллер (ESP32/STM32/ПЛК).
 *
 * Режимы: IDLE → MOVING (синхронный подъём) → SETTLE → LEVELING → HOLD (стабилизация)
 *         + ESTOP / FAULT (с защёлкой до сброса).
 */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});
  const { DEG, clamp, supportGeometry } = LP.math;

  const STATE_NAMES = {
    IDLE: 'Ожидание',
    MOVING: 'Синхронный ход',
    SETTLE: 'Успокоение',
    LEVELING: 'Выравнивание',
    HOLD: 'Удержание горизонта',
    ESTOP: 'Аварийный стоп',
    FAULT: 'Авария'
  };
  const ACTIVE = new Set(['MOVING', 'SETTLE', 'LEVELING', 'HOLD']);

  const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  const fmtS = (v, d = 3) => {
    if (!Number.isFinite(v)) return '—';
    const s = Math.abs(v).toFixed(d);
    return (Number(s) === 0 ? '' : v > 0 ? '+' : '−') + s;
  };

  // Трапециевидный профиль перемещения на расстояние D (скорость v, ускорение a).
  function trapezoid(D, v, a) {
    let ta = v / a, da = 0.5 * a * ta * ta, tc;
    if (2 * da > D) {
      ta = Math.sqrt(D / a);
      v = a * ta;
      da = D / 2;
      tc = 0;
    } else {
      tc = (D - 2 * da) / v;
    }
    const T = 2 * ta + tc;
    return {
      T,
      pos(t) {
        if (t <= 0) return 0;
        if (t < ta) return 0.5 * a * t * t;
        if (t < ta + tc) return da + v * (t - ta);
        if (t < T) return D - 0.5 * a * (T - t) * (T - t);
        return D;
      },
      vel(t) {
        if (t <= 0 || t >= T) return 0;
        if (t < ta) return a * t;
        if (t < ta + tc) return v;
        return a * (T - t);
      }
    };
  }

  class Controller {
    constructor(cfg) {
      this.cfg = cfg;
      this.geo = supportGeometry(cfg.supports);
      this.lambda0 = this.geo.bary(0, 0);
      this.params = { targetHeight: 800, strategy: 'center', stabilize: true, tolDeg: cfg.control.tolDeg };
      this.state = 'IDLE';
      this.stateTime = 0;
      this.t = 0;
      this.auto = false;          // после хода — сразу выравнивать
      this.plannedTarget = null;  // уставка, под которую уже сделан синхронный ход
      this.pending = null;
      this.move = null;
      this.fault = null;
      this.cmd = [0, 0, 0];
      this.powered = true;
      this.lv = null;
      this.enc = [0, 0, 0];
      this.encPrev = null;
      this.encVel = [0, 0, 0];
      this.stallT = [0, 0, 0];
      this.sens = cfg.sensors.map(freshSensor);
      this.tilt = { x: 0, y: 0, valid: false, used: 0 };
      this.pairT = 0;
      this.pairPrev = null;
      this.pairNoise = 0;
      this.fuseN = -1;
      this.height = { value: 0, source: 'enc' };
      this.heightFilt = null;
      this.convT = 0;
      this.devT = 0;
      this.levelStartT = 0;
      this.lastResult = null;
      this.events = [];
      this.eventSeq = 0;
    }

    get stateName() {
      return STATE_NAMES[this.state];
    }

    // ---------- внешние команды ----------
    setTarget(h) {
      this.params.targetHeight = h;
    }

    command(name) {
      if (name === 'stop') {
        this.pending = null; // поставленный в очередь «Сброс» не должен снять стоп
        this._enterStop('ESTOP', 'нажат аварийный стоп');
        return;
      }
      this.pending = name;
    }

    log(level, msg) {
      this.events.push({ t: this.t, level, msg });
      this.eventSeq++;
      if (this.events.length > 200) this.events.shift();
    }

    // ---------- цикл управления ----------
    step(dt, m) {
      const C = this.cfg.control;
      this.t = m.t;
      this.stateTime += dt;
      this._readEncoders(dt, m.enc);
      this._readSensors(dt, m.incl);
      this._readHeight(dt, m.height);
      this._handlePending();
      this._checkStall(dt);

      if (ACTIVE.has(this.state)) {
        const err = Math.max(Math.abs(this.tilt.x), Math.abs(this.tilt.y));
        if (!this.tilt.valid) this._enterStop('FAULT', 'нет достоверного наклона — отказ инклинометров');
        else if (err > C.maxTiltDeg) this._enterStop('FAULT', `наклон ${err.toFixed(2)}° больше предела ${C.maxTiltDeg}°`);
      }

      let cmd = [0, 0, 0];
      switch (this.state) {
        case 'MOVING':
          cmd = this._stepMove(dt);
          break;
        case 'SETTLE':
          if (this.stateTime >= C.settleTime) this._beginLeveling('после хода');
          break;
        case 'LEVELING':
          cmd = this._stepLevel(dt);
          break;
        case 'HOLD':
          this._stepHold(dt);
          break;
      }
      cmd = this._applyLimits(cmd);
      if (!ACTIVE.has(this.state)) cmd = [0, 0, 0];
      this.cmd = cmd;
      // при аварии и аварийном стопе питание приводов снимается (держат тормоз / самоторможение)
      this.powered = this.state !== 'ESTOP' && this.state !== 'FAULT';
      return cmd;
    }

    // смена железа: датчики другого класса — переинициализировать слияние
    onHardwareChanged() {
      this.sens = this.cfg.sensors.map(freshSensor);
      this.pairT = 0;
      this.pairPrev = null;
      this.pairNoise = 0;
      this.fuseN = -1;
      this.heightFilt = null;
    }

    // точность позиционирования по энкодеру с учётом минимальной скорости привода
    _posTol() {
      const A = this.cfg.actuator, C = this.cfg.control;
      const vMin = A.vMin || 0;
      const coast = vMin ? vMin / C.rate + (vMin * vMin) / (2 * A.aMax) + A.encoderRes : 0;
      return Math.max(0.03, 2 * A.encoderRes, coast);
    }

    // команда скорости с учётом трения покоя: медленнее vMin привод не едет — даём импульс vMin
    _shapeV(v, err) {
      const vMin = this.cfg.actuator.vMin || 0;
      if (!vMin || Math.abs(v) >= vMin) return v;
      return Math.abs(err) > this._posTol() ? Math.sign(err) * vMin : 0;
    }

    _handlePending() {
      const p = this.pending;
      if (!p) return;
      this.pending = null;
      if (p === 'reset') {
        this._reset();
        return;
      }
      if (this.state === 'ESTOP' || this.state === 'FAULT') {
        this.log('warn', 'Команда отклонена: сначала сбросьте аварию');
        return;
      }
      switch (p) {
        case 'auto':
          this.auto = true;
          this._startLift();
          break;
        case 'lift':
          this.auto = false;
          this._startLift();
          break;
        case 'level':
          this.auto = false;
          this._beginLeveling('по команде');
          break;
        case 'lower':
          this.auto = false;
          this.plannedTarget = null;
          this._planMove([0, 0, 0], 'Опускание');
          break;
      }
    }

    // ---------- синхронный ход (подъём / опускание) ----------
    _startLift() {
      const P = this.params;
      const dh = P.targetHeight - this.height.value;
      this._planMove(this.enc.map((e) => e + dh), dh >= 0 ? 'Подъём' : 'Опускание к уставке', P.targetHeight);
    }

    // target — уставка высоты, под которую делается ход (null — ход не к уставке, например опускание)
    _planMove(goals, label, target = null) {
      const A = this.cfg.actuator, C = this.cfg.control;
      const g = goals.map((v) => clamp(v, 0, A.stroke));
      if (g.some((v, i) => Math.abs(v - goals[i]) > 0.01)) this.log('warn', `${label}: цель за пределом хода опор — ограничено`);
      const D = Math.max(...g.map((v, i) => Math.abs(v - this.enc[i])));
      this.move = { label, target, start: this.enc.slice(), goal: g, D, prof: trapezoid(Math.max(D, 1e-6), C.vMove, C.aMove), t: 0 };
      if (D < 0.1) {
        this._finishMove();
        return;
      }
      this._setState('MOVING');
      this.log('info', `${label}: ход ${D.toFixed(1)} мм, ≈${this.move.prof.T.toFixed(1)} с`);
    }

    _stepMove(dt) {
      const m = this.move, C = this.cfg.control;
      if (m.target !== null && m.target !== this.params.targetHeight) {
        // уставку поменяли на ходу — перепланировать от текущего положения
        this.log('info', 'Изменена уставка высоты — новый ход');
        this._startLift();
        return [0, 0, 0];
      }
      // Синхронизация: если какая-то опора отстала от общего профиля — профиль притормаживает,
      // поэтому плита идёт вверх без перекоса даже при разной скорости моторов.
      const s0 = m.prof.pos(m.t) / m.D;
      let lag = 0;
      for (let i = 0; i < 3; i++) lag = Math.max(lag, Math.abs(m.start[i] + (m.goal[i] - m.start[i]) * s0 - this.enc[i]));
      const rate = clamp((C.syncLagMax - lag) / (C.syncLagMax - C.syncLagMin), 0, 1);
      m.t += dt * rate;
      const s = m.prof.pos(m.t) / m.D, sv = (m.prof.vel(m.t) / m.D) * rate;
      const cmd = m.goal.map((g, i) => {
        const span = g - m.start[i], target = m.start[i] + span * s;
        return this._shapeV(span * sv + C.kpSync * (target - this.enc[i]), (m.t >= m.prof.T ? g : target) - this.enc[i]);
      });
      const doneTol = Math.max(0.3, this._posTol() + 0.05);
      if (m.t >= m.prof.T && m.goal.every((g, i) => Math.abs(g - this.enc[i]) < doneTol)) {
        this._finishMove();
        return [0, 0, 0];
      }
      if (this.stateTime > m.prof.T * 1.5 + 10) this._enterStop('FAULT', 'опоры не вышли в заданное положение');
      return cmd;
    }

    _finishMove() {
      const label = this.move ? this.move.label : 'Ход';
      if (this.move && this.move.target !== null) this.plannedTarget = this.move.target;
      this.move = null;
      this.log('info', `${label}: завершено`);
      this._setState(this.auto ? 'SETTLE' : 'IDLE');
    }

    // ---------- выравнивание ----------
    _needsMove() {
      const P = this.params;
      return (
        P.strategy === 'center' &&
        P.targetHeight !== this.plannedTarget &&
        Math.abs(P.targetHeight - this.height.value) > this.cfg.control.moveThreshold
      );
    }

    _beginLeveling(why) {
      if (this._needsMove()) {
        // далеко от уставки — сначала быстрый синхронный ход, потом выравнивание
        this.auto = true;
        this._startLift();
        return;
      }
      this._setState('LEVELING');
      this.levelStartT = this.t;
      this.lv = { phase: 'measure', t: 0, iter: 0, targets: null };
      this.plaus = { enc: this.enc.slice(), x: this.tilt.x, y: this.tilt.y, px: 0, py: 0 };
      this.log('info', `Выравнивание (${why}): X=${fmtS(this.tilt.x)}°, Y=${fmtS(this.tilt.y)}°`);
    }

    _stepLevel(dt) {
      if (this._needsMove()) {
        this.log('info', 'Изменена уставка высоты');
        this.auto = true;
        this._startLift();
        return [0, 0, 0];
      }
      if (this.stateTime > this.cfg.control.levelTimeout) {
        this._enterStop('FAULT', 'выравнивание не сошлось за отведённое время');
        return [0, 0, 0];
      }
      if (!this._plausible()) return [0, 0, 0];
      // привод с минимальной скоростью (DC, гидравлика) — шагами «ход по энкодеру → замер»,
      // остальные — непрерывное П-регулирование по наклону
      return this.cfg.actuator.vMin ? this._stepLevelSteps(dt) : this._stepLevelContinuous(dt);
    }

    // Изменение наклона с начала выравнивания должно совпадать с тем, что дают ходы опор по энкодерам.
    // Ловит согласованный отказ датчиков (одинаковый дрейф, зависание), который голосование не видит.
    _plausible() {
      const pz = this.plaus;
      if (!pz) return true;
      const pl = this.geo.fitPlane(this.enc.map((e, i) => e - pz.enc[i]));
      // предсказание пропускаем через тот же фильтр, что и датчики, — иначе их запаздывание даёт ложное расхождение
      const C = this.cfg.control, al = 1 / (C.rate * C.filterTau + 1);
      pz.px += al * (Math.atan(pl.a) / DEG - pz.px);
      pz.py += al * (Math.atan(pl.b) / DEG - pz.py);
      const mis = Math.max(Math.abs(this.tilt.x - pz.x - pz.px), Math.abs(this.tilt.y - pz.y - pz.py));
      if (mis > this.cfg.control.plausDeg) {
        this._enterStop('FAULT', `наклон по инклинометрам не согласуется с ходом опор (расхождение ${mis.toFixed(2)}°) — подозрение на отказ датчиков`);
        return false;
      }
      return true;
    }

    // медиана остальных исправных датчиков (для проверки «зависания»)
    _othersRef(j) {
      const o = this.sens.filter((s, k) => k !== j && s.installed && s.healthy && s.init).map((s) => s.f);
      if (!o.length) return null;
      const avg = (k) => o.reduce((a, f) => a + f[k], 0) / o.length;
      return [avg(0), avg(1)];
    }

    _inputMoved(j, s) {
      const res = this.cfg.sensor.resolutionDeg || 0.001;
      const ref = this._othersRef(j);
      if (ref && s.sameRef) return Math.max(Math.abs(ref[0] - s.sameRef[0]), Math.abs(ref[1] - s.sameRef[1])) > 2 * res;
      // единственный датчик: «завис», если опоры заметно сдвинулись, а показания нет
      return s.sameEnc ? Math.max(...this.enc.map((e, i) => Math.abs(e - s.sameEnc[i]))) > 0.2 : false;
    }

    // ошибки: εi — насколько опора выше горизонта через центр плиты, мм; eh — ошибка высоты, мм
    _levelError() {
      const P = this.params, C = this.cfg.control;
      const a = Math.tan(this.tilt.x * DEG), b = Math.tan(this.tilt.y * DEG);
      const eps = this.cfg.supports.map((s) => a * s.x + b * s.y);
      const eh = P.targetHeight - this.height.value;
      const err = Math.max(Math.abs(this.tilt.x), Math.abs(this.tilt.y));
      const ok = err <= P.tolDeg && (P.strategy === 'raise' || Math.abs(eh) <= C.tolHeight);
      return { a, b, eps, eh, err, ok };
    }

    _stepLevelContinuous(dt) {
      const C = this.cfg.control, P = this.params;
      const { a, b, eps, eh, ok } = this._levelError();
      // усиление ограничено запаздыванием фильтра датчиков (запас по фазе ≥ ~60°)
      const kp = Math.min(C.kpTilt, 0.5 / C.filterTau);
      let v;
      if (P.strategy === 'raise') {
        // только вверх: поднимаем опоры до уровня самой высокой
        const top = Math.max(...eps);
        v = eps.map((e) => kp * (top - e));
      } else {
        // центр плиты остаётся на месте (Σλi·εi = 0), плюс общая поправка высоты
        const vh = clamp(C.kpHeight * eh, -C.vLevel, C.vLevel);
        v = eps.map((e) => -kp * e + vh);
      }
      // ограничение скорости с сохранением пропорций — плита движется без «рысканья»
      const vm = Math.max(...v.map(Math.abs));
      if (vm > C.vLevel) v = v.map((x) => (x * C.vLevel) / vm);
      this.convT = ok ? this.convT + dt : 0;
      if (this.convT >= Math.max(C.confirmTime, 2.5 * C.filterTau)) {
        this._levelDone(a, b);
        return [0, 0, 0];
      }
      return v;
    }

    _stepLevelSteps(dt) {
      const C = this.cfg.control, A = this.cfg.actuator, P = this.params, lv = this.lv;
      lv.t += dt;
      if (lv.phase === 'move') {
        const tol = this._posTol();
        const cmd = lv.targets.map((g, i) => {
          const e = g - this.enc[i];
          if (Math.abs(e) <= tol) {
            lv.reached[i] = true;
            return 0;
          }
          if (lv.reached[i] && Math.abs(e) <= 3 * tol) return 0;
          return this._shapeV(clamp(C.kpPos * e, -C.vLevel, C.vLevel), e);
        });
        const done = lv.reached.every(Boolean);
        if (!done && lv.t < 30) return cmd;
        lv.phase = 'measure';
        lv.t = 0;
        return [0, 0, 0];
      }
      // замер: приводы стоят, ждём, пока успокоится фильтр инклинометров
      if (lv.t < 3 * C.filterTau + 0.3) return [0, 0, 0];
      const { a, b, eps, eh, err, ok } = this._levelError();
      if (ok) {
        this._levelDone(a, b);
        return [0, 0, 0];
      }
      if (++lv.iter > C.maxIter) {
        if (err <= C.restartDeg) {
          this.log('warn', `Допуск ${P.tolDeg}° не достигнут за ${C.maxIter} шагов — предел разрешения привода, остаток ${err.toFixed(3)}°`);
          this._levelDone(a, b);
        } else this._enterStop('FAULT', `выравнивание не сходится за ${C.maxIter} шагов`);
        return [0, 0, 0];
      }
      let d;
      if (P.strategy === 'raise') {
        const top = Math.max(...eps);
        d = eps.map((e) => top - e);
      } else d = eps.map((e) => -e + eh);
      lv.targets = this.enc.map((e, i) => clamp(e + d[i], 0, A.stroke));
      lv.reached = [false, false, false];
      lv.phase = 'move';
      lv.t = 0;
      return [0, 0, 0];
    }

    _levelDone(a, b) {
      const spread = this.cfg.platform.size * (Math.abs(a) + Math.abs(b));
      const dur = this.t - this.levelStartT;
      const steps = this.lv && this.lv.iter ? `, шагов ${this.lv.iter}` : '';
      this.lastResult = { t: this.t, dur, x: this.tilt.x, y: this.tilt.y, spread, h: this.height.value };
      this.log('ok', `Выровнено за ${dur.toFixed(1)} с${steps}: X=${fmtS(this.tilt.x)}°, Y=${fmtS(this.tilt.y)}°, перепад углов ≈${spread.toFixed(2)} мм`);
      this.auto = false;
      this._setState('HOLD');
    }

    // ---------- удержание / стабилизация ----------
    _stepHold(dt) {
      const C = this.cfg.control, P = this.params;
      if (!P.stabilize) {
        this.devT = 0;
        return;
      }
      if (this._needsMove()) {
        this.log('info', 'Изменена уставка высоты');
        this.auto = true;
        this._startLift();
        return;
      }
      const eh = P.targetHeight - this.height.value;
      const err = Math.max(Math.abs(this.tilt.x), Math.abs(this.tilt.y));
      const tiltDev = err > Math.max(C.restartDeg, 2 * P.tolDeg);
      const hDev = P.strategy === 'center' && Math.abs(eh) > C.restartHeight;
      this.devT = tiltDev || hDev ? this.devT + dt : 0;
      // тихий уход чуть за допуск (дрейф, утечки) — исправляем, если держится дольше
      this.slowDevT = err > 1.25 * P.tolDeg ? (this.slowDevT || 0) + dt : 0;
      if (this.devT >= C.restartDelay || this.slowDevT >= C.slowRestartDelay) {
        this.slowDevT = 0;
        const why = tiltDev ? `стабилизация, наклон ${err.toFixed(3)}°` : `стабилизация, высота ${fmtS(-eh, 1)} мм`;
        this._beginLeveling(why);
      }
    }

    // ---------- защиты ----------
    _applyLimits(cmd) {
      const A = this.cfg.actuator, C = this.cfg.control;
      return cmd.map((v, i) => {
        const lo = this.enc[i] <= C.strokeMargin && v < 0;
        const hi = this.enc[i] >= A.stroke - C.strokeMargin && v > 0;
        if (!lo && !hi) return v;
        if (this.state === 'LEVELING') {
          this._enterStop('FAULT', `опора ${this.cfg.supports[i].id} у ${hi ? 'верхнего' : 'нижнего'} предела хода — на этой высоте выровнять нельзя`);
        }
        return 0;
      });
    }

    _checkStall(dt) {
      const C = this.cfg.control;
      if (!ACTIVE.has(this.state)) {
        this.stallT = [0, 0, 0];
        return;
      }
      for (let i = 0; i < 3; i++) {
        const c = this.cmd[i], v = this.encVel[i];
        const stuck = Math.abs(c) > 1 && (Math.abs(v) < 0.15 * Math.abs(c) || Math.sign(v) !== Math.sign(c));
        this.stallT[i] = stuck ? this.stallT[i] + dt : 0;
        if (this.stallT[i] > C.stallTime) {
          this._enterStop('FAULT', `опора ${this.cfg.supports[i].id} не движется при команде ${c.toFixed(1)} мм/с (перегрузка или заклинивание)`);
          return;
        }
      }
    }

    _enterStop(kind, msg) {
      if (this.state === 'ESTOP' || (this.state === 'FAULT' && kind === 'FAULT')) return;
      this.auto = false;
      this.plannedTarget = null;
      this.move = null;
      this.fault = msg;
      this.cmd = [0, 0, 0];
      this._setState(kind);
      this.log('error', (kind === 'ESTOP' ? 'СТОП: ' : 'АВАРИЯ: ') + msg);
    }

    _reset() {
      this.sens = this.cfg.sensors.map(freshSensor);
      this.pairT = 0;
      this.pairPrev = null;
      this.pairNoise = 0;
      this.fuseN = -1;
      this.stallT = [0, 0, 0];
      if (this.state === 'ESTOP' || this.state === 'FAULT') {
        this.fault = null;
        this.auto = false;
        this.move = null;
        this._setState('IDLE');
        this.log('info', 'Сброс: авария снята, инклинометры переинициализированы');
      } else {
        this.log('info', 'Сброс: инклинометры переинициализированы');
      }
    }

    _setState(s) {
      if (s !== 'LEVELING') this.plaus = null;
      this.state = s;
      this.stateTime = 0;
      this.convT = 0;
      this.devT = 0;
    }

    // ---------- обработка измерений ----------
    _readEncoders(dt, enc) {
      if (this.encPrev) for (let i = 0; i < 3; i++) this.encVel[i] = (enc[i] - this.encPrev[i]) / dt;
      this.encPrev = enc.slice();
      this.enc = enc.slice();
    }

    _readSensors(dt, incl) {
      const C = this.cfg.control;
      const alpha = dt / (C.filterTau + dt);
      const beta = dt / (1 + dt);
      const N = this.cfg.sensorCount || 3;
      incl.forEach((r, j) => {
        const s = this.sens[j];
        s.installed = j < N;
        if (!s.installed) {
          s.raw = null;
          s.init = false;
          return;
        }
        s.raw = r;
        if (!r.ok || !Number.isFinite(r.x) || !Number.isFinite(r.y)) {
          this._exclude(j, 'нет связи');
          s.init = false;
          return;
        }
        if (!s.init) {
          s.f = [r.x, r.y];
          s.lastRaw = [r.x, r.y];
          s.sameT = 0;
          s.init = true;
          return;
        }
        s.f[0] += alpha * (r.x - s.f[0]);
        s.f[1] += alpha * (r.y - s.f[1]);
        const same = r.x === s.lastRaw[0] && r.y === s.lastRaw[1];
        if (same && s.sameT === 0) {
          s.sameRef = this._othersRef(j);
          s.sameEnc = this.enc.slice();
        }
        s.sameT = same ? s.sameT + dt : 0;
        s.lastRaw = [r.x, r.y];
        if (s.sameT > C.stuckTime && this._inputMoved(j, s)) this._exclude(j, 'зависание');
      });

      const ok = [];
      this.sens.forEach((s, j) => s.installed && s.healthy && s.init && ok.push(j));
      if (ok.length !== this.fuseN) {
        // состав исправных датчиков изменился — оценки шума начинаем заново
        this.fuseN = ok.length;
        for (const s of this.sens) s.prevRes = null;
        this.pairPrev = null;
      }

      // Слияние: 3 исправных — медиана по каждой оси (один неисправный датчик не влияет),
      // 2 исправных — среднее с проверкой согласия, меньше — наклон недостоверен.
      if (ok.length === 3) {
        const F = this.sens.map((s) => s.f), R = this.sens.map((s) => s.lastRaw);
        const mx = median3(F[0][0], F[1][0], F[2][0]);
        const my = median3(F[0][1], F[1][1], F[2][1]);
        const rx = median3(R[0][0], R[1][0], R[2][0]);
        const ry = median3(R[0][1], R[1][1], R[2][1]);
        for (const j of ok) {
          const s = this.sens[j];
          // Шум оцениваем по остатку «датчик минус медиана»: общее движение плиты
          // (резкая просадка, перестановка груза) у всех датчиков одинаковое и вычитается.
          const res = [s.lastRaw[0] - rx, s.lastRaw[1] - ry];
          if (s.prevRes) {
            const d = Math.max(Math.abs(res[0] - s.prevRes[0]), Math.abs(res[1] - s.prevRes[1]));
            s.noise += beta * (d - s.noise);
          }
          s.prevRes = res;
          // медленно отслеживаем собственное смещение датчика (температура, старение) — τ 30 с
          const kb = dt / (30 + dt);
          s.relBias[0] += kb * (s.f[0] - mx - s.relBias[0]);
          s.relBias[1] += kb * (s.f[1] - my - s.relBias[1]);
          const dev = Math.max(Math.abs(s.f[0] - s.relBias[0] - mx), Math.abs(s.f[1] - s.relBias[1] - my));
          s.devT = dev > C.faultDeg ? s.devT + dt : 0;
          if (s.devT > C.faultTime) this._exclude(j, 'расхождение с остальными');
          else if (s.noise > C.noiseFaultDeg) this._exclude(j, 'шум');
        }
        this.pairT = 0;
        this.tilt = { x: mx, y: my, valid: true, used: 3 };
      } else if (ok.length === 2) {
        // двое не могут «проголосовать», кто неисправен: при расхождении или шуме — недостоверно
        const p = this.sens[ok[0]], q = this.sens[ok[1]];
        const dis = Math.max(Math.abs(p.f[0] - q.f[0]), Math.abs(p.f[1] - q.f[1]));
        const diff = [p.lastRaw[0] - q.lastRaw[0], p.lastRaw[1] - q.lastRaw[1]];
        if (this.pairPrev) {
          const d = Math.max(Math.abs(diff[0] - this.pairPrev[0]), Math.abs(diff[1] - this.pairPrev[1])) / 2;
          this.pairNoise += beta * (d - this.pairNoise);
        }
        this.pairPrev = diff;
        const bad = dis > C.faultDeg || this.pairNoise > C.noiseFaultDeg;
        this.pairT = bad ? this.pairT + dt : 0;
        this.tilt = { x: (p.f[0] + q.f[0]) / 2, y: (p.f[1] + q.f[1]) / 2, valid: this.pairT <= C.faultTime, used: 2 };
      } else if (ok.length === 1 && N === 1) {
        // единственный датчик: шум — по собственным приращениям, смещение и дрейф не обнаружить
        const s = this.sens[ok[0]];
        if (s.prevRes && s.prevRes2) {
          const d2 = (k) => Math.abs(s.lastRaw[k] - 2 * s.prevRes[k] + s.prevRes2[k]);
          const d = Math.min(Math.max(d2(0), d2(1)) / 2, 3 * C.noiseFaultDeg);
          s.noise += beta * (d - s.noise);
        }
        s.prevRes2 = s.prevRes;
        s.prevRes = s.lastRaw.slice();
        if (s.noise > C.noiseFaultDeg) this._exclude(ok[0], 'шум');
        this.tilt = { x: s.f[0], y: s.f[1], valid: s.healthy, used: 1 };
      } else {
        this.tilt = { x: this.tilt.x, y: this.tilt.y, valid: false, used: ok.length };
      }
    }

    _exclude(j, reason) {
      const s = this.sens[j];
      if (!s.healthy) return;
      s.healthy = false;
      s.reason = reason;
      this.log('warn', `Инклинометр ${this.cfg.sensors[j].id} исключён: ${reason}`);
    }

    _readHeight(dt, h) {
      if (h !== null && h !== undefined && Number.isFinite(h)) {
        const a = dt / (0.2 + dt);
        this.heightFilt = this.heightFilt === null ? h : this.heightFilt + a * (h - this.heightFilt);
        this.height = { value: this.heightFilt, source: 'laser' };
      } else {
        // без датчика высоты — оценка по энкодерам (не видит неровность пола и просадку опор)
        this.heightFilt = null;
        const A = this.cfg.actuator, T = this.cfg.platform.thickness;
        let v = T;
        for (let i = 0; i < 3; i++) v += this.lambda0[i] * (A.bodyLength + this.enc[i]);
        this.height = { value: v, source: 'enc' };
      }
    }
  }

  function freshSensor() {
    return { f: [0, 0], init: false, healthy: true, reason: '', devT: 0, sameT: 0, sameRef: null, sameEnc: null, lastRaw: null, prevRes: null, prevRes2: null, noise: 0, relBias: [0, 0], raw: null };
  }

  LP.Controller = Controller;
  LP.STATE_NAMES = STATE_NAMES;
  LP.trapezoid = trapezoid;
  LP.fmtS = fmtS;
})(typeof window !== 'undefined' ? window : globalThis);
