/* Интерфейс: связывает симуляцию, 3D-вид, графики и панель управления. */
(function () {
  'use strict';
  const cfg = LP.config;
  const DEG = Math.PI / 180;
  const $ = (id) => document.getElementById(id);
  const f = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const fs = (v, d) => LP.fmtS(v, d);

  // ---------- симуляция и стартовый сценарий ----------
  const HW = LP.hardware;
  let hwSel = { ...HW.DEFAULT };
  HW.applyHardware(cfg, hwSel);
  const sim = new LP.Simulation(cfg, 20261014);
  const { plant, ctrl } = sim;
  plant.randomizeFloor(12);
  plant.randomizeMotors(cfg.actuator.gainSpread);
  plant.setPayload(150, 200, -150);
  ctrl.setTarget(800);

  const STATE_CLASS = { IDLE: 'idle', MOVING: 'move', SETTLE: 'move', LEVELING: 'level', HOLD: 'ok', ESTOP: 'err', FAULT: 'err' };
  const FAULTS = [['none', 'нет'], ['offset', 'смещение'], ['drift', 'дрейф'], ['stuck', 'зависание'], ['noisy', 'шум'], ['dead', 'нет связи']];
  const SUP_COLORS = ['#4cc2ff', '#f78166', '#d2a8ff'];

  let speed = 1, paused = false, exag = 5;

  // ---------- 3D ----------
  let view = null;
  try {
    if (!LP.View3D) throw new Error('three.js не загружен');
    view = new LP.View3D($('view3d'), cfg);
    view.onPick = (x, y) => setPayload({ x: Math.round(x / 10) * 10, y: Math.round(y / 10) * 10 }, true);
  } catch (e) {
    console.error(e);
    $('view3d').innerHTML = '<div class="no3d">3D-вид недоступен (не загрузился three.js — нужен интернет).<br>Симуляция, графики и управление работают.</div>';
  }

  // ---------- графики ----------
  const chartTilt = new LP.TimeChart($('chartTilt'), {
    symlog: 0.01, symmetric: true, minSpan: 0.1, digits: 3,
    band: () => ctrl.params.tolDeg,
    series: [
      { label: 'X', color: '#4cc2ff', get: (h) => h.tx },
      { label: 'Y', color: '#f78166', get: (h) => h.ty }
    ]
  });
  const chartHeight = new LP.TimeChart($('chartHeight'), {
    minSpan: 10, digits: 1,
    series: [
      { label: 'уставка', color: '#8b98a8', dash: [5, 4], get: (h) => h.target },
      { label: 'факт', color: '#3ddc84', get: (h) => h.h }
    ]
  });
  const chartCorr = new LP.TimeChart($('chartCorr'), {
    minSpan: 2, symmetric: true, digits: 2,
    series: cfg.supports.map((s, i) => ({
      label: s.id, color: SUP_COLORS[i],
      get: (h) => h.ext[i] - (h.ext[0] + h.ext[1] + h.ext[2]) / 3
    }))
  });

  // ---------- управление ----------
  const A = cfg.actuator, base = A.bodyLength + cfg.platform.thickness;
  const hMin = base + 50, hMax = base + A.stroke - 50;
  const hr = $('heightRange'), hn = $('heightNum');
  for (const e of [hr, hn]) {
    e.min = hMin;
    e.max = hMax;
  }
  function applyHeight(raw) {
    const n = parseFloat(raw);
    if (raw === '' || !Number.isFinite(n)) {
      hr.value = hn.value = ctrl.params.targetHeight;
      return;
    }
    const v = Math.round(Math.min(hMax, Math.max(hMin, n)));
    hr.value = hn.value = v;
    if (v !== ctrl.params.targetHeight) {
      ctrl.setTarget(v);
      sim.note(`Уставка высоты: ${v} мм`);
    }
  }
  hr.addEventListener('input', () => (hn.value = hr.value));
  hr.addEventListener('change', () => applyHeight(hr.value));
  hn.addEventListener('change', () => applyHeight(hn.value));
  hr.value = hn.value = ctrl.params.targetHeight;

  document.querySelectorAll('[data-cmd]').forEach((b) =>
    b.addEventListener('click', (e) => {
      sim.command(b.dataset.cmd);
      if (e.detail > 0) b.blur(); // клик мышью — снять фокус, иначе пробел повторит команду
    })
  );

  $('strategy').addEventListener('change', (e) => (ctrl.params.strategy = e.target.value));
  $('tol').addEventListener('change', (e) => {
    const v = Math.min(0.5, Math.max(0.005, Number(e.target.value) || cfg.control.tolDeg));
    e.target.value = v;
    ctrl.params.tolDeg = v;
  });
  $('stabilize').addEventListener('change', (e) => (ctrl.params.stabilize = e.target.checked));

  // ---------- железо ----------
  const fillSelect = (el, list, val) => {
    el.innerHTML = list.map((x) => `<option value="${x.id}">${x.price ? x.price + ' · ' : ''}${x.name}</option>`).join('');
    el.value = val;
  };
  fillSelect($('hwAct'), HW.actuators, hwSel.actuator);
  fillSelect($('hwIncl'), HW.inclinometers, hwSel.inclinometer);
  fillSelect($('hwHeight'), HW.heightSensors, hwSel.height);
  $('hwCount').value = hwSel.sensorCount;
  function showNotes() {
    $('hwActNote').textContent = HW.byId(HW.actuators, hwSel.actuator).note;
    $('hwInclNote').textContent = HW.byId(HW.inclinometers, hwSel.inclinometer).note;
  }
  function syncNoiseSlider() {
    noise.min = cfg.sensor.resolutionDeg;
    noise.max = Math.max(0.02, 2 * cfg.sensor.noiseDeg);
    noise.step = Math.min(0.001, cfg.sensor.resolutionDeg);
    noise.value = plant.sensorNoise;
    $('noiseVal').textContent = plant.sensorNoise.toFixed(4);
  }
  function changeHardware(key, val, label) {
    hwSel = { ...hwSel, [key]: val };
    sim.setHardware(hwSel);
    syncNoiseSlider();
    showNotes();
    sim.note(label);
    updateAssess();
  }
  $('hwAct').addEventListener('change', (e) => changeHardware('actuator', e.target.value, `Привод: ${HW.byId(HW.actuators, e.target.value).name}`));
  $('hwIncl').addEventListener('change', (e) => changeHardware('inclinometer', e.target.value, `Инклинометры: ${HW.byId(HW.inclinometers, e.target.value).name}`));
  $('hwCount').addEventListener('change', (e) => changeHardware('sensorCount', Number(e.target.value), `Установлено инклинометров: ${e.target.value}`));
  $('hwHeight').addEventListener('change', (e) => changeHardware('height', e.target.value, `Датчик высоты: ${HW.byId(HW.heightSensors, e.target.value).name}`));
  const temp = $('temp');
  temp.addEventListener('input', () => {
    plant.tempC = Number(temp.value);
    $('tempVal').textContent = temp.value;
  });
  temp.addEventListener('change', () => sim.note(`Температура среды ${temp.value} °C (калибровка при 20 °C)`));
  showNotes();

  function updateAssess() {
    const r = HW.assess(sim);
    const v = $('verdict');
    v.className = 'verdict ' + (r.holdsDead ? 'ok' : 'warn');
    v.textContent = r.holdsDead
      ? `Комплект держит горизонт «мёртво»: ±${r.accuracy.toFixed(3)}°, без подстроек и без питания`
      : 'Комплект не держит «мёртво» — см. пункты ниже';
    $('assess').innerHTML = r.items
      .map((i) => `<div class="it ${i.level}"><span class="ic">${i.level === 'ok' ? '✔' : i.level === 'warn' ? '!' : '✘'}</span><span class="tx"><b>${i.title}:</b> ${i.text}</span></div>`)
      .join('');
  }

  $('exag').addEventListener('input', (e) => {
    exag = Number(e.target.value);
    $('exagVal').textContent = exag;
  });
  $('speed').addEventListener('change', (e) => (speed = Number(e.target.value)));
  const pauseBtn = $('pauseBtn');
  function togglePause() {
    paused = !paused;
    pauseBtn.textContent = paused ? '▶ Пуск' : '⏸ Пауза';
  }
  pauseBtn.addEventListener('click', togglePause);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      sim.command('stop');
      e.preventDefault();
    } else if (e.key === ' ' && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement.tagName)) {
      togglePause();
      e.preventDefault();
    }
  });

  // ---------- возмущения ----------
  const floorAmp = $('floorAmp');
  floorAmp.addEventListener('input', () => ($('floorAmpVal').textContent = floorAmp.value));
  $('floorBtn').addEventListener('click', () => {
    plant.randomizeFloor(Number(floorAmp.value));
    sim.note(`Новый рельеф пола: ${plant.floor.map((v, i) => cfg.supports[i].id + ' ' + fs(v, 1)).join(', ')} мм`);
  });
  $('settleBtn').addEventListener('click', () => {
    const i = Math.floor(Math.random() * 3), mm = 3 + Math.random() * 5;
    plant.settle(i, mm);
    sim.note(`Просадка опоры ${cfg.supports[i].id} на ${mm.toFixed(1)} мм`);
  });

  const mass = $('mass'), px = $('px'), py = $('py');
  function setPayload(p, fromPick) {
    const cur = plant.payload;
    const m = p.mass ?? cur.mass, x = Math.max(-450, Math.min(450, p.x ?? cur.x)), y = Math.max(-450, Math.min(450, p.y ?? cur.y));
    plant.setPayload(m, x, y);
    mass.value = m;
    px.value = x;
    py.value = y;
    $('massVal').textContent = m;
    $('pxVal').textContent = x;
    $('pyVal').textContent = y;
    if (fromPick) sim.note(`Груз ${m} кг поставлен в (${x}, ${y}) мм`);
  }
  mass.addEventListener('input', () => setPayload({ mass: Number(mass.value) }));
  px.addEventListener('input', () => setPayload({ x: Number(px.value) }));
  py.addEventListener('input', () => setPayload({ y: Number(py.value) }));
  for (const e of [mass, px, py]) e.addEventListener('change', () => sim.note(`Груз ${plant.payload.mass} кг в (${plant.payload.x}, ${plant.payload.y}) мм`));

  const noise = $('noise');
  noise.addEventListener('input', () => {
    plant.sensorNoise = Number(noise.value);
    $('noiseVal').textContent = Number(noise.value).toFixed(4);
  });
  const motor = $('motor');
  motor.addEventListener('input', () => ($('motorVal').textContent = motor.value));
  motor.addEventListener('change', () => {
    plant.randomizeMotors(Number(motor.value) / 100);
    sim.note(`Скорости моторов: ${plant.act.map((a, i) => cfg.supports[i].id + ' ' + fs(a.gainErr * 100, 1) + '%').join(', ')}`);
  });

  // ---------- таблицы ----------
  const supRows = cfg.supports.map((s, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><b style="color:${SUP_COLORS[i]}">${s.id}</b> <span class="muted">${s.name}</span></td>` +
      '<td class="num"><span data-k="ext"></span><div class="bar"><i data-k="bar"></i></div></td>' +
      '<td class="num" data-k="v"></td><td class="num" data-k="F"></td><td class="num" data-k="d"></td><td class="num" data-k="fl"></td>';
    $('supBody').appendChild(tr);
    return Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((e) => [e.dataset.k, e]));
  });

  const sensRows = cfg.sensors.map((s, j) => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td><b>${s.id}</b></td><td class="num" data-k="x"></td><td class="num" data-k="y"></td><td data-k="st"></td>` +
      `<td><select>${FAULTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></td>`;
    tr.querySelector('select').addEventListener('change', (e) => {
      plant.setSensorFault(j, e.target.value);
      const name = FAULTS.find(([v]) => v === e.target.value)[1];
      sim.note(e.target.value === 'none' ? `Инклинометр ${s.id}: отказ снят (нажмите «Сброс», чтобы вернуть в работу)` : `Инклинометр ${s.id}: имитация отказа «${name}»`);
    });
    $('sensBody').appendChild(tr);
    return Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((e) => [e.dataset.k, e]));
  });

  // ---------- обновление интерфейса ----------
  const set = (id, txt, cls) => {
    const e = $(id);
    e.textContent = txt;
    if (cls !== undefined) e.className = cls;
  };
  const tiltCls = (v) => {
    const a = Math.abs(v), tol = ctrl.params.tolDeg;
    return a <= tol ? 'good' : a <= 5 * tol ? 'mid' : 'bad';
  };
  let logSeq = -1;

  function updateUI() {
    const st = ctrl.state;
    const badge = $('stateBadge');
    badge.textContent = ctrl.stateName + (st === 'MOVING' && ctrl.move ? ` · ${ctrl.move.label.toLowerCase()}` : '');
    badge.className = 'badge ' + STATE_CLASS[st];
    $('simTime').textContent = sim.t.toFixed(1);

    const banner = $('faultBanner');
    if (st === 'FAULT' || st === 'ESTOP') {
      banner.textContent = `${st === 'ESTOP' ? 'Аварийный стоп' : 'Авария'}: ${ctrl.fault}. Устраните причину и нажмите «Сброс».`;
      banner.classList.remove('hidden');
    } else banner.classList.add('hidden');

    const tl = ctrl.tilt;
    set('mTiltX', fs(tl.x, 3) + '°', tl.valid ? tiltCls(tl.x) : 'bad');
    set('mTiltY', fs(tl.y, 3) + '°', tl.valid ? tiltCls(tl.y) : 'bad');
    set('mHeight', f(ctrl.height.value, 1) + (ctrl.height.source === 'laser' ? ' мм · лазер' : ' мм · энкодеры'));
    set('mSpread', f(cfg.platform.size * (Math.abs(Math.tan(tl.x * DEG)) + Math.abs(Math.tan(tl.y * DEG))), 2) + ' мм');
    const nInst = cfg.sensorCount || 3;
    set('mUsed', `${tl.used} из ${nInst}`, tl.used === nInst ? (nInst >= 3 ? 'good' : 'mid') : 'bad');

    set('tTiltX', fs(plant.tiltX, 4) + '°', tiltCls(plant.tiltX));
    set('tTiltY', fs(plant.tiltY, 4) + '°', tiltCls(plant.tiltY));
    set('tHeight', f(plant.heightCenter, 2) + ' мм');
    set('tSpread', f(plant.cornerSpread, 2) + ' мм', plant.cornerSpread <= 0.5 ? 'good' : plant.cornerSpread <= 3 ? 'mid' : 'bad');
    const he = plant.heightCenter - ctrl.params.targetHeight;
    set('tHerr', fs(he, 2) + ' мм', Math.abs(he) <= 1 ? 'good' : Math.abs(he) <= 10 ? 'mid' : 'bad');

    const r = ctrl.lastResult, res = $('lastResult');
    if (r) {
      res.classList.remove('hidden');
      res.textContent = `Последнее выравнивание: ${r.dur.toFixed(1)} с, X ${fs(r.x, 3)}°, Y ${fs(r.y, 3)}°, перепад углов ≈ ${r.spread.toFixed(2)} мм (t = ${r.t.toFixed(1)} с)`;
    }

    // предупреждения модели
    const warns = [];
    plant.act.forEach((a, i) => {
      if (a.force < 0) warns.push(`Груз вне опорного треугольника — опора ${cfg.supports[i].id} работает на отрыв`);
    });
    plant.act.forEach((a, i) => {
      if (a.force > A.maxForce) warns.push(`Перегрузка опоры ${cfg.supports[i].id}: ${(a.force / 1000).toFixed(2)} кН > ${(A.maxForce / 1000).toFixed(0)} кН`);
    });
    if (!ctrl.params.stabilize && st === 'HOLD') warns.push('Стабилизация выключена — отклонения не исправляются');
    $('warnings').innerHTML = warns.map((w) => `<div class="warn">⚠ ${w}</div>`).join('');

    plant.act.forEach((a, i) => {
      const row = supRows[i];
      row.ext.textContent = f(a.ext, 2);
      row.bar.style.width = ((a.ext / A.stroke) * 100).toFixed(1) + '%';
      row.v.textContent = fs(a.vel, 2);
      row.F.textContent = f(a.force / 1000, 2);
      row.F.className = 'num' + (a.force > A.maxForce ? ' bad' : '');
      row.d.textContent = f(plant.defl[i], 2);
      row.fl.textContent = fs(plant.floor[i], 1);
    });

    ctrl.sens.forEach((s, j) => {
      const row = sensRows[j];
      if (j >= (cfg.sensorCount || 3)) {
        row.x.textContent = row.y.textContent = '—';
        row.st.textContent = 'не установлен';
        row.st.className = 'muted';
        return;
      }
      const live = s.init && s.raw && s.raw.ok;
      row.x.textContent = live ? fs(s.f[0], 3) : '—';
      row.y.textContent = live ? fs(s.f[1], 3) : '—';
      row.st.textContent = s.healthy ? 'в работе' : 'исключён';
      row.st.title = s.healthy ? '' : s.reason;
      row.st.className = s.healthy ? 'good' : 'bad';
    });

    if (ctrl.eventSeq !== logSeq) {
      logSeq = ctrl.eventSeq;
      $('log').innerHTML = ctrl.events
        .slice(-80)
        .reverse()
        .map((e) => `<div class="${e.level}"><span class="t">${e.t.toFixed(1)} с</span>${e.msg}</div>`)
        .join('');
    }
  }

  function drawCharts() {
    chartTilt.draw(sim.history, sim.t);
    chartHeight.draw(sim.history, sim.t);
    chartCorr.draw(sim.history, sim.t);
    LP.drawBubble($('bubble'), ctrl.tilt.x, ctrl.tilt.y, ctrl.params.tolDeg, ctrl.tilt.valid);
  }

  // ---------- главный цикл ----------
  let last = performance.now(), acc = 0, uiAcc = 1, assessAcc = 1;
  function frame(now) {
    const dtReal = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) {
      acc += dtReal * speed;
      let n = Math.floor(acc / sim.dt);
      acc -= n * sim.dt;
      n = Math.min(n, 20000);
      for (let k = 0; k < n; k++) sim.stepOnce();
    }
    if (view) {
      view.update(sim, exag);
      view.render();
    }
    uiAcc += dtReal;
    if (uiAcc >= 0.1) {
      uiAcc = 0;
      updateUI();
      drawCharts();
    }
    assessAcc += dtReal;
    if (assessAcc >= 0.5) {
      assessAcc = 0;
      updateAssess();
    }
    requestAnimationFrame(frame);
  }
  // при перезагрузке браузер может восстановить старые значения полей — выставляем их из модели
  $('speed').value = speed;
  $('exag').value = exag;
  $('exagVal').textContent = exag;
  $('tol').value = ctrl.params.tolDeg;
  $('strategy').value = ctrl.params.strategy;
  $('stabilize').checked = ctrl.params.stabilize;
  floorAmp.value = 12;
  $('floorAmpVal').textContent = 12;
  motor.value = cfg.actuator.gainSpread * 100;
  $('motorVal').textContent = motor.value;
  temp.value = plant.tempC;
  $('tempVal').textContent = plant.tempC;
  $('hwCount').value = hwSel.sensorCount;
  setPayload({});
  syncNoiseSlider();
  sim.note('Платформа задвинута, стоит на неровном полу. Нажмите «АВТО».');
  requestAnimationFrame(frame);

  window.sim = sim; // для отладки из консоли
})();
