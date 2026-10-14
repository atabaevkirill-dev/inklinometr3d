/* Страница расчёта: собирает входные данные, считает три раскладки опор, рисует карты и таблицы. */
(function () {
  'use strict';
  const C = LP.calc, G = 9.81;
  const $ = (id) => document.getElementById(id);
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '∞');
  const kN = (v) => (v / 1000).toFixed(2);
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  function readInputs() {
    const num = (id, def) => {
      const v = Number($(id).value);
      return Number.isFinite(v) ? v : def;
    };
    return {
      size: 1000, n: 40, material: $('material').value, t: Math.max(5, num('t', 30)), k: Math.max(100, num('k', 3000)),
      payload: { m: Math.max(0, num('m', 0)), x: num('px', 0), y: num('py', 0), size: Math.max(0, num('ps', 0)), hc: Math.max(0, num('hc', 0)) },
      v: Math.max(1, num('v', 5)), sf: Math.max(1, num('sf', 1.5)),
      stroke: Math.max(50, num('stroke', 470)), K: num('K', 2)
    };
  }

  // ---------- карты на плане ----------
  function drawMap(canvas, r, P0, mode) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2), W = canvas.clientWidth;
    canvas.width = canvas.height = Math.round(W * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const L = P0.size, X = (x) => ((x + L / 2) / L) * W, Y = (y) => ((L / 2 - y) / L) * W;
    const pl = r.pl, cell = (W / pl.n) * 1.02;
    let val, color, maxAbs = 0;
    if (mode === 'allow') {
      const ref = Math.max(P0.payload.m, 50);
      color = (m) => {
        const t = Math.max(0, Math.min(1, m / (2 * ref)));
        return `hsl(${t * 130}, 65%, ${30 + t * 8}%)`;
      };
      val = (p) => r.mAllow[p];
    } else {
      const all = [];
      for (let p = 0; p < pl.nn; p++) all.push([...pl.coords(p), r.w[p]]);
      const bp = C.fitPlane(all);
      const dev = all.map(([x, y, z]) => z - (bp.c + bp.a * x + bp.b * y));
      maxAbs = Math.max(...dev.map(Math.abs), 1e-6);
      color = (d) => {
        const t = Math.max(-1, Math.min(1, d / maxAbs));
        return `hsl(${t >= 0 ? 140 - 140 * t : 140 + 90 * -t}, 70%, ${36 + 10 * Math.abs(t)}%)`;
      };
      val = (p) => dev[p];
    }
    for (let p = 0; p < pl.nn; p++) {
      const [x, y] = pl.coords(p);
      g.fillStyle = color(val(p));
      g.fillRect(X(x) - cell / 2, Y(y) - cell / 2, cell, cell);
    }
    // опорный многоугольник
    g.strokeStyle = 'rgba(255,255,255,.85)';
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    g.beginPath();
    r.pts.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
    g.closePath();
    g.stroke();
    g.setLineDash([]);
    // пятно груза
    const py = P0.payload;
    if (py.m > 0) {
      const s = Math.max(py.size, 40);
      g.strokeStyle = '#ffd166';
      g.lineWidth = 1.5;
      g.strokeRect(X(py.x - s / 2), Y(py.y + s / 2), (s / L) * W, (s / L) * W);
    }
    // общий центр тяжести
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    const cx = X(r.gx), cy = Y(r.gy);
    g.beginPath();
    g.moveTo(cx - 7, cy);
    g.lineTo(cx + 7, cy);
    g.moveTo(cx, cy - 7);
    g.lineTo(cx, cy + 7);
    g.stroke();
    // опоры с нагрузкой
    g.font = '600 11px system-ui, sans-serif';
    g.textAlign = 'center';
    r.pts.forEach(([x, y], i) => {
      g.fillStyle = '#0b0f14';
      g.beginPath();
      g.arc(X(x), Y(y), 8, 0, 2 * Math.PI);
      g.fill();
      g.strokeStyle = '#4cc2ff';
      g.lineWidth = 2;
      g.stroke();
      const txt = `${kN(r.R[i])} кН`, ty = Y(y) + (y > 0 ? 22 : -14);
      const tw = g.measureText(txt).width + 8, tx = Math.max(tw / 2 + 2, Math.min(W - tw / 2 - 2, X(x)));
      g.fillStyle = 'rgba(11,15,20,.85)';
      g.fillRect(tx - tw / 2, ty - 10, tw, 14);
      g.fillStyle = r.R[i] < 0 ? '#ff5a5f' : '#e6edf3';
      g.fillText(txt, tx, ty + 1);
    });
    g.strokeStyle = '#33414f';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, W - 1, W - 1);
    return maxAbs;
  }

  // ---------- главный расчёт ----------
  let last = null;
  async function run() {
    $('busy').textContent = 'Считаю…';
    $('run').disabled = true;
    try {
      await compute();
    } catch (e) {
      console.error(e);
      $('busy').textContent = 'Ошибка расчёта: ' + e.message;
    } finally {
      $('run').disabled = false;
    }
  }

  async function compute() {
    const P0 = readInputs();
    await yieldUI();
    const t0 = performance.now();
    const opt = C.optimalTriangle(P0);
    const layouts = [
      ['3 опоры (как в симуляции)', C.LAYOUTS.tri.pts],
      ['3 опоры под ваш груз', opt.pts],
      ['4 опоры', C.LAYOUTS.quad.pts]
    ];
    const res = [];
    for (const [name, pts] of layouts) {
      res.push(C.analyze(name, pts, P0));
      await yieldUI();
    }
    const thick = C.thicknessTable(opt.pts, P0, [['al', 20], ['al', 30], ['al', 40], ['al', 50], ['steel', 15], ['steel', 20], ['steel', 30]]);
    const cyl = C.verifyCylindrical(40);
    await yieldUI();
    last = { P0, res, opt, thick, cyl };
    render();
    $('busy').textContent = `посчитано за ${((performance.now() - t0) / 1000).toFixed(1)} с`;
  }

  function render() {
    const { P0, res, opt, thick, cyl } = last;
    const [cur, best, quad] = res;
    const mode = document.querySelector('input[name=mapmode]:checked').value;

    // карты
    $('maps').innerHTML = res
      .map((r, i) => `<div class="map"><div class="t">${r.name}</div><canvas id="map${i}"></canvas><div class="s">${
        r.pts.length === 3 ? 'плечи ' + r.levers.map((l) => l.toFixed(0)).join(' / ') + ' мм' : 'статически неопределима'
      } · площадь внутри опор ${(r.areaFrac * 100).toFixed(0)}%</div></div>`)
      .join('');
    let maxDefl = 0;
    res.forEach((r, i) => (maxDefl = Math.max(maxDefl, drawMap($(`map${i}`), r, P0, mode))));
    $('mapLegend').innerHTML =
      mode === 'allow'
        ? `<span>отрыв уже при малом грузе</span><div class="bar" style="background:linear-gradient(to right,hsl(0,65%,30%),hsl(65,65%,34%),hsl(130,65%,38%))"></div><span>≥ ${Math.max(P0.payload.m, 50) * 2} кг без отрыва</span>
           <span>· дополнительно к вашему грузу · пунктир — опорный многоугольник · жёлтый — пятно груза · крест — общий ЦТ · подписи — нагрузка на опору</span>`
        : `<span>ниже</span><div class="bar" style="background:linear-gradient(to right,hsl(230,70%,46%),hsl(140,70%,36%),hsl(0,70%,46%))"></div><span>выше наилучшей плоскости (шкала у каждой карты своя)</span>`;

    // сравнение
    const rows = [
      ['Нагрузки на опоры, кН', (r) => r.R.map(kN).join(' / ')],
      ['Самая разгруженная опора, кН', (r) => tag(kN(r.Rmin), r.Rmin > 0.15 * Math.max(...r.R) ? 'ok' : r.Rmin > 0 ? 'warn' : 'bad')],
      ['Запас ЦТ до края опор, мм: с грузом / пустая плита (монтаж)', (r) =>
        `${tag(f(r.margin, 0), r.margin > 150 ? 'ok' : r.margin > 50 ? 'warn' : 'bad')} / ${tag(f(r.marginEmpty, 0), r.marginEmpty > 150 ? 'ok' : r.marginEmpty > 50 ? 'warn' : 'bad')}`],
      [`Боковая сила на высоте ЦТ (${f(cur.hg, 0)} мм) до опрокидывания, если опоры не держат отрыв, Н`, (r) => f(r.sideForce, 0)],
      ['Ошибка высоты одной опоры на 1 мм → изменение нагрузок (опоры как в приводе / жёсткие), Н', (r) =>
        `${f(Math.max(...r.sensR.map(Math.abs)), 0)} / ${f(Math.max(...r.sensRigidR.map(Math.abs)), 0)}`],
      ['Ошибка высоты, при которой опора полностью разгружается, мм', (r) => (r.pts.length > 3 ? tag(f(r.unloadAt, 2), r.unloadAt > 5 ? 'ok' : r.unloadAt > 1 ? 'warn' : 'bad') : tag('не бывает', 'ok'))],
      ['Ровность верха под грузом (размах от наилучшей плоскости, вся плита с углами), мм', (r) => f(r.flat.pv, 3)],
      ['Наклон площадки под грузом относительно плоскости опор (от прогиба), °', (r) => tag(f(r.payloadTilt, 4), r.payloadTilt <= 0.01 ? 'ok' : r.payloadTilt <= 0.02 ? 'warn' : 'bad')],
      ['Прогиб плиты между опорами, мм', (r) => f(r.flat.sagMax, 3)],
      ['Сколько ещё груза выдержит худшая точка плиты без отрыва опоры, кг', (r) => f(r.worstAllow, 0)],
      ['Нужно выравнивать нагрузку между опорами', (r) => (r.pts.length > 3 ? tag('да', 'warn') : tag('нет', 'ok'))]
    ];
    $('cmp').innerHTML = `<tr><th></th>${res.map((r) => `<th>${r.name}</th>`).join('')}</tr>` + rows.map(([n, fn]) => `<tr><td>${n}</td>${res.map((r) => `<td>${fn(r)}</td>`).join('')}</tr>`).join('');
    $('cmpNote').innerHTML = `Плита ${C.MATERIALS[P0.material].name.toLowerCase()} ${P0.t} мм весит ${f(cur.plateMass, 0)} кг. Общий ЦТ (плита + груз ${P0.payload.m} кг) — (${f(cur.gx, 0)}, ${f(cur.gy, 0)}) мм от центра.
      «3 опоры под ваш груз» — тройка точек у края плиты с наибольшим запасом устойчивости и с грузом, и для пустой плиты при монтаже: ${opt.pts.map(([x, y]) => `(${x}, ${y})`).join(', ')}.
      Запас по боковой силе посчитан для ЦТ с грузом; тяжёлые предметы на консольных углах плиты его уменьшают.`;

    // толщина
    $('thick').innerHTML = '<tr><th>Плита</th><th>Масса, кг</th><th>Ровность под грузом, мм</th><th>Наклон груза от прогиба, °</th><th></th></tr>' +
      thick.map((x) => {
        const lvl = x.pv <= 0.2 ? 'ok' : x.pv <= 0.5 ? 'warn' : 'bad';
        return `<tr${x.material === P0.material && x.t === P0.t ? ' class="best"' : ''}><td>${C.MATERIALS[x.material].name}, ${x.t} мм</td><td class="num">${f(x.mass, 0)}</td><td class="num">${f(x.pv, 3)}</td><td class="num">${f(x.tilt, 4)}</td><td>${tag(lvl === 'ok' ? 'ровно' : lvl === 'warn' ? 'заметно' : 'много', lvl)}</td></tr>`;
      }).join('');

    // кинематика
    const span = Math.max(...best.pts.flatMap((a, i) => best.pts.slice(i + 1).map((b) => Math.hypot(a[0] - b[0], a[1] - b[1]))));
    const kin = C.kinematics(span, [0.25, 0.5, 1, 2, 3, 5]);
    $('kinNote').innerHTML = `Штоки вертикальные, а плита наклоняется: проекция расстояния между точками крепления (${f(span, 0)} мм) укорачивается на d·(1 − cos θ).
      Это смещение должны «съесть» шарниры, иначе штоки гнутся. Схема креплений: одна опора — сферический шарнир (фиксирует точку),
      вторая — сфера в пазу (скользит вдоль линии на первую), третья — сфера на плоскости. Это «сфера–паз–плоскость»: держит плиту вбок и от поворота, но не мешает выравниванию.`;
    $('kin').innerHTML = '<tr><th>Наклон плиты, °</th><th>Смещение точек крепления, мм</th><th>Подъём края на 1 м, мм</th></tr>' +
      kin.map((k) => `<tr><td class="num">${k.deg}</td><td class="num">${f(k.shift, 3)}</td><td class="num">${f(Math.tan((k.deg * Math.PI) / 180) * 1000, 1)}</td></tr>`).join('');

    // привод
    const F = Math.max(...best.R) * P0.sf, lever = Math.min(...best.levers);
    const ranked = C.rankDrives({ F, v: P0.v, lever, stroke: P0.stroke, K: P0.K });
    const top = ranked[0];
    $('driveNote').innerHTML = `Расчётная нагрузка на опору: ${kN(Math.max(...best.R))} кН × запас ${P0.sf} = <b>${kN(F)} кН</b>, скорость ${P0.v} мм/с (ход ${P0.stroke} мм ≈ ${f(P0.stroke / P0.v, 0)} с), винт ${P0.K === 2 ? 'со свободным верхом' : 'в направляющей'}.
      ${top.ok ? 'Наверху — лучший вариант: проходит по моменту, оборотам и изгибу, держит без питания, самый простой.' : '<b class="bad">Ни один вариант из каталога не проходит</b> — снизьте скорость, возьмите винт толще или поставьте направляющую.'}`;
    $('drives').innerHTML = '<tr><th>Привод</th><th>Мотор</th><th>Держит без питания</th><th>КПД</th><th>Нужно, Н·м</th><th>об/мин</th><th>Мотор даёт, Н·м</th><th>Запас по моменту</th><th>Изгиб винта: Pкр, кН</th><th>Ход на микрошаг 1/8, мкм</th><th></th></tr>' +
      ranked.slice(0, 12).map((d, i) => `<tr${i === 0 && d.ok ? ' class="best"' : ''}><td>${d.name}${d.screw === 'trap' ? `<br><span class="muted">λ = ${f(d.lamDeg, 2)}° ${d.selfLock ? '<' : '>'} ρ′ = ${f(d.rhoDeg, 2)}°</span>` : ''}</td>
        <td>${d.motorName}</td><td>${tag(d.holds, d.selfLock ? 'ok' : d.stepper ? 'bad' : 'warn')}</td><td class="num">${f(d.eta, 2)}</td><td class="num">${f(d.T, 2)}</td>
        <td class="num">${d.rpmOk ? f(d.rpm, 0) : tag(f(d.rpm, 0) + ' > 1500', 'bad')}</td>
        <td class="num">${f(d.Tav, 2)}</td><td class="num">${tag('×' + f(d.margin, 1), d.torqueOk ? 'ok' : 'bad')}</td>
        <td class="num">${tag(f(d.Pcr / 1000, 1) + ' (×' + f(d.buckleMargin, 1) + ')', d.buckleOk ? 'ok' : 'bad')}</td>
        <td class="num">${f(d.microMm * 1000, 2)}</td><td>${i === 0 && d.ok ? tag('рекомендую', 'ok') : d.ok ? '' : tag('не проходит', 'bad')}</td></tr>`).join('');

    // вывод
    const quadUnload = quad.unloadAt;
    $('verdict').innerHTML = `<h3>${best.margin > 50 && best.Rmin > 0 ? 'Да, выравнивать по 3 точкам — правильно.' : 'По 3 точкам можно, но груз стоит слишком близко к краю — нужна другая раскладка или крепление опор на отрыв.'}</h3>
      <ul>
        <li><b>3 точки всегда задают плоскость.</b> Нагрузка на каждую опору однозначна, плита не «качается». Ошибка высоты опоры только наклоняет плиту (её исправит выравнивание) и не перераспределяет нагрузку: ${f(Math.max(...best.sensR.map(Math.abs)), 0)} Н на 1 мм.</li>
        <li><b>У 4 опор</b> ошибка высоты одной опоры на 1 мм перекидывает ±${f(Math.max(...quad.sensR.map(Math.abs)), 0)} Н. Уже при ${f(quadUnload, 2)} мм опора полностью разгружается, и плита стоит на трёх. Лечится так: датчики силы на опорах с регулированием по силе, либо податливая «следящая» четвёртая опора, либо коромысло или связанные гидроцилиндры на паре опор.</li>
        <li><b>Груз фиксированный — расставьте опоры под него.</b> Тогда нагрузки ${best.R.map(kN).join(' / ')} кН вместо ${cur.R.map(kN).join(' / ')} кН. Запас ЦТ до края треугольника ${f(best.margin, 0)} мм с грузом и ${f(best.marginEmpty, 0)} мм у пустой плиты (у 4 опор ${f(quad.margin, 0)} мм). Боковая сила на высоте ЦТ, которая опрокинет незакреплённую плиту, — больше ${f(best.sideForce, 0)} Н.</li>
        <li><b>Ровность верха даёт плита, а не выравнивание.</b> ${C.MATERIALS[P0.material].name} ${P0.t} мм под этим грузом прогибается с размахом ${f(best.flat.pv, 2)} мм по всей плите (у 4 опор ${f(quad.flat.pv, 2)} мм), а площадка под грузом наклоняется относительно опор на ${f(best.payloadTilt, 4)}°. Если нужно ровнее — см. таблицу толщин. Инклинометры лучше ставить рядом с грузом или на него.</li>
        <li><b>Привод:</b> ${top.ok
          ? `${top.name} + ${top.motorName.replace(/ \(.*/, '')}. Запас по моменту ×${f(top.margin, 1)}, по изгибу винта ×${f(top.buckleMargin, 1)}, ${f(top.microMm * 1000, 2)} мкм на микрошаг. ${top.selfLock ? 'Винт самотормозящий: в статике держит без питания и без тормоза; при вибрации и ударах добавить тормоз или удержание током.' : 'Нужен тормоз.'}`
          : '<b class="bad">из каталога ничего не проходит</b> — снизьте скорость, возьмите винт толще или поставьте направляющую.'}
          Гидравлика для таких нагрузок и скоростей избыточна: станция, клапаны, утечки, нужны гидрозамки и подстройка.</li>
      </ul>`;

    // проверка
    const geo = LP.math.supportGeometry(best.pts.map(([x, y]) => ({ x, y })));
    const l0 = geo.bary(0, 0), lp = geo.bary(...best.payloadCenter);
    const statics = l0.map((l, i) => G * (best.plateMass * l + P0.payload.m * lp[i]));
    const sumR = best.R.reduce((a, b) => a + b, 0);
    $('verify').innerHTML = `<ul>
      <li>МКЭ на точной задаче (плита на двух опёртых кромках, ν = 0): прогиб ${f(cyl.fem, 5)} мм, точно ${f(cyl.exact, 5)} мм — ошибка ${f(cyl.err * 100, 3)}%.</li>
      <li>Реакции 3 опор по МКЭ ${best.R.map((v) => f(v, 1)).join(' / ')} Н и по статике (барицентрические веса) ${statics.map((v) => f(v, 1)).join(' / ')} Н. Должны совпадать: 3 опоры — статически определимая система.</li>
      <li>Сумма реакций ${f(sumR, 1)} Н = вес плиты и груза ${f(best.W, 1)} Н.</li>
      <li>Сетка ${P0.n}×${P0.n} элементов по ${P0.size / P0.n} мм, элемент Кирхгофа ACM, опоры — пружины ${P0.k} Н/мм. Груз распределён по пятну ${P0.payload.size}×${P0.payload.size} мм.</li>
    </ul>`;
  }

  const tag = (txt, lvl) => `<span class="tag ${lvl}">${txt}</span>`;

  $('run').addEventListener('click', run);
  document.querySelectorAll('.inputs input, .inputs select').forEach((e) => e.addEventListener('change', run));
  document.querySelectorAll('input[name=mapmode]').forEach((e) => e.addEventListener('change', () => last && render()));
  window.addEventListener('resize', () => last && render());
  run();
})();
