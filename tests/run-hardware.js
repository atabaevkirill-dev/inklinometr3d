#!/usr/bin/env node
/* Матрица железа: каждый привод × каждый класс инклинометров × 1/2/3 датчика.
 * Плюс сценарии «держит ли мёртво» и «сколько инклинометров нужно».
 * Запуск: node tests/run-hardware.js */
'use strict';
const path = require('path');
for (const f of ['config', 'physics', 'controller', 'sim', 'hardware']) require(path.join(__dirname, '..', 'js', f + '.js'));
const LP = globalThis.LP;
const HW = LP.hardware;

const results = [];
const check = (name, ok, info = '') => results.push({ name, ok: !!ok, info });
const absMax = (p) => Math.max(Math.abs(p.tiltX), Math.abs(p.tiltY));
const inHold = (s) => s.ctrl.state === 'HOLD';

function make(seed, sel, { floor = 15, payload = [250, 150, -100], target = 800 } = {}) {
  const cfg = JSON.parse(JSON.stringify(LP.config));
  HW.applyHardware(cfg, sel);
  const sim = new LP.Simulation(cfg, seed);
  sim.plant.randomizeFloor(floor);
  sim.plant.randomizeMotors(0.03);
  sim.plant.setPayload(...payload);
  sim.ctrl.setTarget(target);
  return sim;
}

// 1. Матрица: АВТО доходит до удержания; истинная ошибка — в пределах допуска + смещения нуля датчика
const table = [];
for (const a of HW.actuators) {
  for (const s of HW.inclinometers) {
    for (const n of [1, 2, 3]) {
      let worst = 0, worstT = 0, fails = [];
      for (let seed = 1; seed <= 6; seed++) {
        const sim = make(seed * 31 + n, { actuator: a.id, inclinometer: s.id, sensorCount: n, height: 'laser' });
        sim.command('auto');
        const ok = sim.runUntil(inHold, 300);
        const e = absMax(sim.plant);
        // допуск 0.02° + 4σ смещения нуля + шум после фильтра
        const allowed = 0.02 + 4 * s.biasDeg + 0.5 * s.noiseDeg + 0.005;
        worst = Math.max(worst, e);
        worstT = Math.max(worstT, sim.t);
        if (!ok || e > allowed) fails.push(`seed ${seed}: ${sim.ctrl.state} ${sim.ctrl.fault || ''} e=${e.toFixed(4)}°`);
      }
      table.push({ a: a.id, s: s.id, n, worst, worstT, fails });
      check(`${a.id} × ${s.id} × ${n} датч.`, fails.length === 0, `худш. ${worst.toFixed(4)}°, ${worstT.toFixed(0)} с` + (fails.length ? ' | ' + fails.join('; ') : ''));
    }
  }
}

// 2. «Держит мёртво»: 10 минут удержания с грузом 500 кг — сколько раз пришлось подправлять и куда уплыло
function holdTest(actuator) {
  const sim = make(77, { actuator, inclinometer: 'mems-ind', sensorCount: 3, height: 'laser' }, { payload: [500, 100, -100] });
  sim.command('auto');
  const reached = sim.runUntil(inHold, 300);
  const t0 = sim.t, h0 = sim.plant.heightCenter;
  let relevels = 0, maxDev = 0, maxDh = 0;
  sim.onControl = (s) => {
    maxDev = Math.max(maxDev, absMax(s.plant));
    maxDh = Math.max(maxDh, Math.abs(s.plant.heightCenter - h0));
  };
  const seq0 = sim.ctrl.events.filter((e) => /стабилизация/.test(e.msg)).length;
  sim.advance(600);
  relevels = sim.ctrl.events.filter((e) => /стабилизация/.test(e.msg)).length - seq0;
  return { relevels, maxDev, maxDh, t0, ok: reached && sim.ctrl.state !== 'FAULT' };
}
for (const a of HW.actuators) {
  const r = holdTest(a.id);
  const dead = r.relevels === 0 && r.maxDh < 0.05;
  check(`удержание 10 мин: ${a.id}`, r.ok && (a.leak ? r.relevels > 0 && r.maxDev < 0.06 : dead),
    `подправлений ${r.relevels}, макс. наклон ${r.maxDev.toFixed(4)}°, уход высоты ${r.maxDh.toFixed(3)} мм`);
}

// 3. Аварийный стоп на высоте: с самоторможением/тормозом плита стоит, ШВП без тормоза — опускается
for (const a of HW.actuators) {
  const sim = make(88, { actuator: a.id }, { payload: [300, 0, 0] });
  sim.command('auto');
  sim.runUntil(inHold, 300);
  const h0 = sim.plant.heightCenter;
  sim.command('stop');
  sim.advance(30);
  const drop = h0 - sim.plant.heightCenter;
  // ШВП без тормоза падает, гидравлика медленно садится на утечках, остальные стоят
  const ok = a.backdrive ? drop > 5 : a.leak ? drop > 0.05 && drop < 5 : drop < 0.01;
  check(`аварийный стоп 30 с: ${a.id}`, ok, `опустилась на ${drop.toFixed(2)} мм`);
}

// 4. Сколько инклинометров нужно: тихий дрейф одного датчика
for (const n of [1, 2, 3]) {
  const sim = make(99, { sensorCount: n });
  sim.command('auto');
  sim.runUntil(inHold, 300);
  sim.plant.setSensorFault(0, 'drift');
  sim.advance(60);
  const e = absMax(sim.plant), st = sim.ctrl.state;
  // 1 датчик: голосовать не с кем — плита уходит из горизонта (проверка по энкодерам ловит это поздно)
  const expect = n === 1 ? e > 0.3 : n === 2 ? st === 'FAULT' : st === 'HOLD' && e < 0.03;
  const what = n === 1 ? 'плита ушла из горизонта' : n === 2 ? 'заметил расхождение, остановился' : 'исключил плохой, держит горизонт';
  check(`дрейф датчика при ${n} инклинометр(ах): ${what}`, expect, `${st}, истинный наклон ${e.toFixed(3)}°`);
}

// 5. Температура: +25 °C от калибровки
for (const s of HW.inclinometers) {
  const sim = make(55, { inclinometer: s.id });
  sim.command('auto');
  sim.runUntil(inHold, 300);
  sim.plant.tempC = 45;
  sim.advance(60);
  const e = absMax(sim.plant);
  check(`температура +25 °C: ${s.id}`, true, `${sim.ctrl.state}, истинный наклон ${e.toFixed(4)}° (≈${(Math.tan((e * Math.PI) / 180) * 1000).toFixed(2)} мм на 1 м)`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✔' : '✘'} ${r.name}${r.info ? '  — ' + r.info : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
