#!/usr/bin/env node
/* Безголовые сценарии: проверяют, что контроллер поднимает, выравнивает,
 * стабилизирует и корректно уходит в аварию. Запуск: node tests/run-sim.js */
'use strict';
const path = require('path');
for (const f of ['config', 'physics', 'controller', 'sim']) require(path.join(__dirname, '..', 'js', f + '.js'));
const LP = globalThis.LP;

const results = [];
function check(name, cond, info = '') {
  results.push({ name, ok: !!cond, info });
}
const cfgCopy = () => JSON.parse(JSON.stringify(LP.config));
const absMax = (p) => Math.max(Math.abs(p.tiltX), Math.abs(p.tiltY));

function make(seed, { floor = 15, motors = 0.05, payload = null, laser = true, target = 800, strategy = 'center' } = {}) {
  const sim = new LP.Simulation(cfgCopy(), seed);
  const r = sim.plant.rng;
  sim.plant.randomizeFloor(floor);
  sim.plant.randomizeMotors(motors);
  if (payload) sim.plant.setPayload(...payload);
  else sim.plant.setPayload(r.uniform(0, 500), r.uniform(-300, 300), r.uniform(-300, 250));
  sim.plant.hasHeightSensor = laser;
  sim.ctrl.setTarget(target);
  sim.ctrl.params.strategy = strategy;
  return sim;
}
const inHold = (s) => s.ctrl.state === 'HOLD';

// 0. Геометрия
{
  const g = LP.math.supportGeometry(LP.config.supports);
  const l = g.bary(123, -77);
  check('геометрия: Σλ = 1', Math.abs(l[0] + l[1] + l[2] - 1) < 1e-12);
  const pl = g.fitPlane(LP.config.supports.map((s) => 5 + 0.01 * s.x - 0.02 * s.y));
  check('геометрия: плоскость через 3 точки', Math.abs(pl.c - 5) < 1e-9 && Math.abs(pl.a - 0.01) < 1e-12 && Math.abs(pl.b + 0.02) < 1e-12);
  const tr = LP.trapezoid(470, 25, 40);
  check('профиль: доходит до конца', Math.abs(tr.pos(tr.T) - 470) < 1e-9 && Math.abs(tr.pos(tr.T - 1e-6) - 470) < 1e-3);
}

// 1. Монте-Карло: АВТО (подъём + выравнивание) при случайном поле, грузе, моторах и высоте
{
  const tol = LP.config.control.tolDeg;
  let fails = [], worstTilt = 0, worstH = 0, worstT = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const r = new LP.math.Rng(seed * 7919);
    const sim = make(seed, { target: Math.round(r.uniform(400, 1050)) });
    sim.command('auto');
    const ok = sim.runUntil(inHold, 200);
    const p = sim.plant;
    const tErr = absMax(p), hErr = Math.abs(p.heightCenter - sim.ctrl.params.targetHeight);
    worstTilt = Math.max(worstTilt, tErr);
    worstH = Math.max(worstH, hErr);
    worstT = Math.max(worstT, sim.t);
    if (!ok || tErr > tol + 0.01 || hErr > 1.0 || p.cornerSpread > 0.8) fails.push(`seed ${seed}: ${sim.ctrl.state} ${sim.ctrl.fault || ''} tilt=${tErr.toFixed(4)} h=${hErr.toFixed(2)}`);
  }
  check('АВТО ×60: горизонт и высота в допуске', fails.length === 0,
    `худший наклон ${worstTilt.toFixed(4)}°, высота ${worstH.toFixed(2)} мм, время ${worstT.toFixed(1)} с` + (fails.length ? '\n    ' + fails.join('\n    ') : ''));
}

// 2. Без лазера — горизонт держится, высота по энкодерам
{
  const sim = make(3, { laser: false });
  sim.command('auto');
  const ok = sim.runUntil(inHold, 200);
  check('без датчика высоты: горизонт в допуске', ok && absMax(sim.plant) < 0.03,
    `наклон ${absMax(sim.plant).toFixed(4)}°, ошибка высоты ${(sim.plant.heightCenter - 800).toFixed(1)} мм (неровность пола + просадка)`);
}

// 3. Стратегия «только подъём»: при выравнивании ни одна опора не опускается
{
  const sim = make(5, { strategy: 'raise' });
  let minV = Infinity;
  sim.onControl = (s) => {
    if (s.ctrl.state === 'LEVELING') minV = Math.min(minV, ...s.ctrl.cmd);
  };
  sim.command('auto');
  const ok = sim.runUntil(inHold, 200);
  check('«только подъём»: опоры не опускаются', ok && minV >= -1e-9 && absMax(sim.plant) < 0.03, `мин. команда ${minV.toFixed(4)} мм/с`);
}

// 4. Стабилизация: груз переставили, опора просела — платформа сама возвращается в горизонт
{
  const sim = make(11, { payload: [100, 0, 0] });
  sim.command('auto');
  sim.runUntil(inHold, 200);
  sim.plant.setPayload(450, 300, -300);
  const left = sim.runUntil((s) => s.ctrl.state === 'LEVELING', 10);
  const back = left && sim.runUntil(inHold, 60);
  check('стабилизация: перестановка груза', back && absMax(sim.plant) < 0.03, `наклон ${absMax(sim.plant).toFixed(4)}°`);
  sim.plant.settle(2, 6);
  const left2 = sim.runUntil((s) => s.ctrl.state === 'LEVELING', 10);
  const back2 = left2 && sim.runUntil(inHold, 60);
  check('стабилизация: просадка опоры C на 6 мм', back2 && absMax(sim.plant) < 0.03 && Math.abs(sim.plant.heightCenter - 800) < 1,
    `наклон ${absMax(sim.plant).toFixed(4)}°, высота ${sim.plant.heightCenter.toFixed(2)}`);
}

// 5. Отказ одного инклинометра — исключается, выравнивание не страдает
for (const fault of ['offset', 'drift', 'stuck', 'noisy', 'dead']) {
  const sim = make(21, {});
  sim.command('auto');
  sim.advance(8); // идёт подъём
  sim.plant.setSensorFault(1, fault);
  const ok = sim.runUntil(inHold, 200);
  sim.advance(10);
  const excluded = !sim.ctrl.sens[1].healthy;
  check(`отказ датчика «${fault}»: исключён, горизонт в допуске`, ok && excluded && absMax(sim.plant) < 0.03 && sim.ctrl.state === 'HOLD',
    `${sim.ctrl.state}, исключён=${excluded} (${sim.ctrl.sens[1].reason}), наклон ${absMax(sim.plant).toFixed(4)}°`);
}

// 6. Отказ двух датчиков — авария, моторы стоят
{
  const sim = make(22, {});
  sim.command('auto');
  sim.advance(5);
  sim.plant.setSensorFault(0, 'dead');
  sim.plant.setSensorFault(2, 'offset');
  sim.advance(3);
  const vmax = Math.max(...sim.plant.act.map((a) => Math.abs(a.vel)));
  check('отказ 2 датчиков: авария и стоп', sim.ctrl.state === 'FAULT' && vmax < 1e-6, `${sim.ctrl.state}: ${sim.ctrl.fault}`);
}

// 7. Аварийный стоп во время подъёма; команды блокируются до сброса
{
  const sim = make(23, {});
  sim.command('auto');
  sim.advance(6);
  sim.command('stop');
  sim.advance(1);
  const vmax = Math.max(...sim.plant.act.map((a) => Math.abs(a.vel)));
  sim.command('lift');
  sim.advance(1);
  const blocked = sim.ctrl.state === 'ESTOP';
  sim.command('reset');
  sim.advance(0.1);
  check('аварийный стоп: остановка ≤1 с, блокировка, сброс', vmax < 1e-6 && blocked && sim.ctrl.state === 'IDLE', `v=${vmax}`);
}

// 8. Опускание
{
  const sim = make(24, {});
  sim.command('auto');
  sim.runUntil(inHold, 200);
  sim.command('lower');
  const ok = sim.runUntil((s) => s.ctrl.state === 'IDLE', 80);
  check('опускание до упора', ok && sim.plant.act.every((a) => a.ext < 0.35), sim.plant.act.map((a) => a.ext.toFixed(2)).join(', '));
}

// 9. Новая уставка в режиме удержания — платформа сама переезжает и выравнивается
{
  const sim = make(25, {});
  sim.command('auto');
  sim.runUntil(inHold, 200);
  sim.ctrl.setTarget(1000);
  const ok = sim.runUntil((s) => s.ctrl.state === 'MOVING', 5) && sim.runUntil(inHold, 200);
  check('смена уставки 800→1000 в удержании', ok && Math.abs(sim.plant.heightCenter - 1000) < 1 && absMax(sim.plant) < 0.03,
    `h=${sim.plant.heightCenter.toFixed(2)}, наклон ${absMax(sim.plant).toFixed(4)}°`);
}

// 10. Перегрузка опоры — мотор встаёт, контроллер это ловит
{
  const sim = make(26, { payload: [1000, -400, -400] });
  sim.command('auto');
  sim.advance(10);
  check('перегрузка: авария «не движется»', sim.ctrl.state === 'FAULT' && /не движется/.test(sim.ctrl.fault || ''), `${sim.ctrl.state}: ${sim.ctrl.fault}`);
}

// 11. Не хватает хода — авария с понятной причиной, а не бесконечный цикл
{
  const sim = make(27, { floor: 0, payload: [0, 0, 0] });
  sim.plant.floor = [-40, 0, 0];
  sim.ctrl.setTarget(1125);
  sim.command('auto');
  sim.runUntil((s) => s.ctrl.state === 'FAULT' || s.ctrl.state === 'HOLD', 200);
  check('нехватка хода: авария «предел хода»', sim.ctrl.state === 'FAULT' && /предел/.test(sim.ctrl.fault || ''), `${sim.ctrl.state}: ${sim.ctrl.fault}`);
}

// 12. Синхронность подъёма при разбросе моторов ±5%
{
  const sim = make(28, { floor: 0, payload: [0, 0, 0] });
  sim.plant.act.forEach((a, i) => (a.gainErr = [-0.05, 0.05, 0][i]));
  let worst = 0;
  sim.onControl = (s) => {
    if (s.ctrl.state === 'MOVING') worst = Math.max(worst, absMax(s.plant));
  };
  sim.command('lift');
  sim.runUntil((s) => s.ctrl.state === 'IDLE', 60);
  check('синхронный подъём: перекос < 0.15°', worst < 0.15, `макс. наклон при подъёме ${worst.toFixed(3)}°`);
}

// 13. Регрессии по ревью
{
  // «Выровнять» во время подъёма: ход перепланируется, без ложной аварии по таймауту
  let fails = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const sim = make(300 + seed, { target: 1080 });
    sim.command('auto');
    sim.advance(0.5 + (seed % 5) * 0.5);
    sim.command('level');
    const ok = sim.runUntil(inHold, 150);
    if (!ok || Math.abs(sim.plant.heightCenter - 1080) > 1) fails++;
  }
  check('«Выровнять» во время подъёма ×20: без аварии, высота в допуске', fails === 0, `неудач ${fails}`);
}
{
  // смена уставки во время подъёма: платформа не продолжает ехать к старой цели
  const sim = make(201, { target: 1050 });
  sim.command('auto');
  sim.advance(3);
  const h0 = sim.plant.heightCenter;
  sim.ctrl.setTarget(450);
  let hMax = 0;
  sim.onControl = (x) => (hMax = Math.max(hMax, x.plant.heightCenter));
  const ok = sim.runUntil(inHold, 120);
  check('смена уставки на ходу 1050→450: без перелёта', ok && hMax < Math.max(h0, 450) + 10 && Math.abs(sim.plant.heightCenter - 450) < 1,
    `высота при смене ${h0.toFixed(0)}, максимум после ${hMax.toFixed(0)}, итог ${sim.plant.heightCenter.toFixed(1)}`);
}
{
  // два отказа одновременно не должны давать «тихий» неверный горизонт
  let silent = 0;
  for (let seed = 1; seed <= 20; seed++) {
    for (const fault of ['offset', 'drift']) {
      const sim = make(400 + seed, {});
      sim.command('auto');
      sim.runUntil(inHold, 200);
      sim.plant.setSensorFault(0, fault);
      sim.plant.setSensorFault(1, fault);
      sim.advance(60);
      if (sim.ctrl.state !== 'FAULT' && absMax(sim.plant) > 0.1) silent++;
    }
  }
  check('два отказа ×40: нет «тихого» ухода из горизонта', silent === 0, `тихих уходов ${silent}`);
}
{
  // «Сброс» в очереди не снимает аварийный стоп, нажатый следом
  const sim = make(501, {});
  sim.command('auto');
  sim.advance(3);
  sim.command('reset');
  sim.command('stop');
  sim.advance(0.5);
  check('сброс, затем стоп в одном такте: остаётся стоп', sim.ctrl.state === 'ESTOP', sim.ctrl.state);
}
{
  // широкий допуск не вызывает бесконечных перевыравниваний в удержании
  const sim = make(502, { strategy: 'raise' });
  sim.ctrl.params.tolDeg = 0.5;
  sim.command('auto');
  sim.runUntil(inHold, 200);
  const n0 = sim.ctrl.events.filter((e) => /стабилизация/.test(e.msg)).length;
  sim.advance(60);
  const n1 = sim.ctrl.events.filter((e) => /стабилизация/.test(e.msg)).length;
  check('допуск 0.5°: нет повторных выравниваний', n1 === n0, `повторов ${n1 - n0}`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? '✔' : '✘'} ${r.name}${r.info ? '  — ' + r.info : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed ? 1 : 0);
