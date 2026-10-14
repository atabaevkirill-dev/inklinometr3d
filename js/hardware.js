/* Каталог железа: классы приводов, инклинометров и датчиков высоты с типовыми параметрами.
 * Значения — типовые для класса, не паспорт конкретной модели: перед покупкой сверять с даташитом.
 * applyHardware() записывает выбранные параметры в конфиг; модель и контроллер читают их «на лету».
 */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});

  const actuators = [
    {
      id: 'screwjack', name: 'Червячный домкрат Tr20×4 1:10 + шаговый NEMA 23 с энкодером', price: '₽₽',
      vMax: 6, aMax: 30, stiffness: 3000, maxForce: 10000, backlash: 0.25, encoderRes: 0.005, vMin: 0,
      selfLocking: true, brake: false, leak: 0, backdrive: 0,
      vMove: 5, aMove: 10, vLevel: 3,
      note: 'Рекомендуемый (см. расчёт): самотормозящий в статике, держит без питания. До ~5 мм/с. Люфт гайки выбирается весом плиты.'
    },
    {
      id: 'ballservo', name: 'Электроцилиндр ШВП + серводвигатель с тормозом', price: '₽₽₽',
      vMax: 80, aMax: 300, stiffness: 6000, maxForce: 8000, backlash: 0.02, encoderRes: 0.001, vMin: 0,
      selfLocking: false, brake: true, leak: 0, backdrive: 0,
      vMove: 40, aMove: 80, vLevel: 10,
      note: 'Быстрый и точный. ШВП не самотормозит — держит тормоз мотора.'
    },
    {
      id: 'ballservo-nb', name: 'Электроцилиндр ШВП + серводвигатель без тормоза', price: '₽₽',
      vMax: 80, aMax: 300, stiffness: 6000, maxForce: 8000, backlash: 0.02, encoderRes: 0.001, vMin: 0,
      selfLocking: false, brake: false, leak: 0, backdrive: 4,
      vMove: 40, aMove: 80, vLevel: 10,
      note: 'Держит только под током. При аварийном стопе или пропадании питания плита опускается.'
    },
    {
      id: 'dc', name: 'Линейный актуатор 24 В (DC-мотор, датчик Холла)', price: '₽',
      vMax: 12, aMax: 40, stiffness: 800, maxForce: 6000, backlash: 0.6, encoderRes: 0.05, vMin: 2.5,
      selfLocking: true, brake: false, leak: 0, backdrive: 0,
      vMove: 10, aMove: 20, vLevel: 8,
      note: 'Дешёвый, но мягкий, с люфтом и грубым шагом: медленнее 2.5 мм/с не едет — выравнивание шагами.'
    },
    {
      id: 'hydro', name: 'Гидроцилиндр + пропорциональный клапан', price: '₽₽₽',
      vMax: 40, aMax: 150, stiffness: 1500, maxForce: 30000, backlash: 0, encoderRes: 0.01, vMin: 0.8,
      selfLocking: false, brake: false, leak: 0.01, backdrive: 0,
      vMove: 25, aMove: 50, vLevel: 6,
      note: 'Огромное усилие, но утечки: плита понемногу садится, нужна постоянная подстройка или гидрозамки.'
    }
  ];

  const inclinometers = [
    {
      id: 'mems-cheap', name: 'Бюджетный MEMS-акселерометр (класс MPU-6050 / ADXL345)', price: '₽',
      noiseDeg: 0.05, resolutionDeg: 0.01, biasDeg: 0.03, tempCoef: 0.008, filterTau: 0.5,
      faultDeg: 0.2, noiseFaultDeg: 0.3,
      note: 'Шумный, сильно плывёт от температуры. Точность горизонта хуже 0.05°.'
    },
    {
      id: 'mems-ind', name: 'Промышленный MEMS-инклинометр RS-485/CAN, класс 0.01°', price: '₽₽',
      noiseDeg: 0.004, resolutionDeg: 0.001, biasDeg: 0.005, tempCoef: 0.0015, filterTau: 0.25,
      faultDeg: 0.1, noiseFaultDeg: 0.08,
      note: 'Разумный выбор: 0.01° — это ≈0.17 мм на 1 м.'
    },
    {
      id: 'mems-prec', name: 'Прецизионный MEMS (класс Murata SCA100T)', price: '₽₽₽',
      noiseDeg: 0.0015, resolutionDeg: 0.0005, biasDeg: 0.002, tempCoef: 0.0008, filterTau: 0.25,
      faultDeg: 0.05, noiseFaultDeg: 0.05,
      note: 'Точнее и стабильнее по температуре.'
    },
    {
      id: 'servo', name: 'Серво-/электролитический инклинометр (лабораторный класс)', price: '₽₽₽₽',
      noiseDeg: 0.0003, resolutionDeg: 0.0001, biasDeg: 0.0005, tempCoef: 0.0002, filterTau: 0.6,
      faultDeg: 0.03, noiseFaultDeg: 0.03,
      note: 'Максимальная точность, но медленный отклик.'
    }
  ];

  const heightSensors = [
    { id: 'none', name: 'Нет — высота по энкодерам', noise: null, note: 'Не видит неровность пола и просадку опор.' },
    { id: 'laser', name: 'Лазерный дальномер (класс ±1 мм)', noise: 0.3, note: 'Абсолютная высота центра.' },
    { id: 'laser-tri', name: 'Лазерный триангуляционный датчик (класс ±0.05 мм)', noise: 0.02, note: 'Точный, но малый диапазон — ставят на подвижную штангу.' }
  ];

  const byId = (list, id) => list.find((x) => x.id === id) || list[0];

  const DEFAULT = { actuator: 'screwjack', inclinometer: 'mems-ind', sensorCount: 3, height: 'laser' };

  function applyHardware(cfg, sel) {
    sel = Object.assign({}, DEFAULT, sel);
    const a = byId(actuators, sel.actuator), s = byId(inclinometers, sel.inclinometer), h = byId(heightSensors, sel.height);
    Object.assign(cfg.actuator, {
      vMax: a.vMax, aMax: a.aMax, stiffness: a.stiffness, maxForce: a.maxForce, backlash: a.backlash,
      encoderRes: a.encoderRes, vMin: a.vMin, selfLocking: a.selfLocking, brake: a.brake, leak: a.leak, backdrive: a.backdrive
    });
    Object.assign(cfg.sensor, { noiseDeg: s.noiseDeg, resolutionDeg: s.resolutionDeg, biasDeg: s.biasDeg, tempCoef: s.tempCoef });
    Object.assign(cfg.control, {
      vMove: a.vMove, aMove: a.aMove, vLevel: a.vLevel,
      filterTau: s.filterTau, faultDeg: s.faultDeg, noiseFaultDeg: s.noiseFaultDeg
    });
    cfg.heightSensor = { id: h.id, noise: h.noise };
    cfg.sensorCount = Math.max(1, Math.min(3, sel.sensorCount | 0));
    cfg.hardware = { ...sel, actuatorName: a.name, inclinometerName: s.name, heightName: h.name };
    return cfg;
  }

  LP.hardware = { actuators, inclinometers, heightSensors, byId, DEFAULT, applyHardware };
})(typeof window !== 'undefined' ? window : globalThis);

/* Проверка комплекта: хватает ли выбранного железа, чтобы выровнять и удержать плиту. */
(function (root) {
  'use strict';
  const LP = root.LP;
  const DEG = Math.PI / 180, G = 9.81;

  function assess(sim) {
    const cfg = sim.cfg, A = cfg.actuator, S = cfg.sensor, C = cfg.control, P = cfg.platform, plant = sim.plant, ctrl = sim.ctrl;
    const geo = plant.geo, half = P.size / 2, out = [];
    const add = (level, title, text) => out.push({ level, title, text });
    const corners = [[-half, -half], [half, -half], [half, half], [-half, half]];
    const lam = corners.map(([x, y]) => geo.bary(x, y));
    const lmax = [0, 1, 2].map((i) => Math.max(...lam.map((l) => l[i])));
    const lmin = [0, 1, 2].map((i) => Math.min(...lam.map((l) => l[i])));
    const m = plant.payload.mass;

    // 1. Усилие: груз в самом невыгодном месте плиты
    const Fworst = Math.max(...[0, 1, 2].map((i) => G * (P.mass * plant.lambda0[i] + m * lmax[i])));
    const k = A.maxForce / Fworst;
    add(k >= 1.5 ? 'ok' : k >= 1 ? 'warn' : 'bad', 'Усилие опор',
      `худший случай (груз ${m} кг у края над опорой) ${(Fworst / 1000).toFixed(2)} кН при номинале ${(A.maxForce / 1000).toFixed(1)} кН — запас ×${k.toFixed(2)}${k < 1.5 ? ', нужен ×1.5 и больше' : ''}`);

    // 2. Отрыв опоры: груз вне опорного треугольника
    const mNoLift = Math.min(...[0, 1, 2].map((i) => (lmin[i] < 0 ? (P.mass * plant.lambda0[i]) / -lmin[i] : Infinity)));
    add(m <= mNoLift ? 'ok' : 'warn', 'Отрыв опоры',
      `без растяжения в опорах в любом месте плиты — груз до ${mNoLift.toFixed(0)} кг; тяжелее — опоры должны держать на отрыв (болтовое крепление), иначе плита опрокинется`);

    // 3. Удержание без движения
    const Fnow = Math.max(...plant.act.map((a) => a.force));
    if (A.selfLocking) add('ok', 'Удержание', 'привод самотормозящий — держит положение без питания');
    else if (A.brake) add('ok', 'Удержание', 'держит тормоз мотора; без питания тормоз замыкается');
    else if (A.backdrive) add('bad', 'Удержание', `держит только под током: при аварии или пропадании питания шток уходит вниз со скоростью ≈${(A.backdrive * Fnow / 1000).toFixed(1)} мм/с — нужен тормоз`);
    if (A.leak) add('warn', 'Утечки', `плита садится ≈${(A.leak * Fnow / 1000 * 60).toFixed(1)} мм/мин — нужна постоянная подстройка или гидрозамки`);

    // 4. Жёсткость: просадка под грузом и перекос при его перестановке
    const d = plant.act.map((a) => a.force / A.stiffness);
    const dMax = Math.max(...[0, 1, 2].map((i) => (G * (P.mass * plant.lambda0[i] + m * lmax[i])) / A.stiffness));
    add(dMax < 1 ? 'ok' : dMax < 3 ? 'warn' : 'bad', 'Жёсткость опор',
      `просадка сейчас ${Math.min(...d).toFixed(2)}…${Math.max(...d).toFixed(2)} мм, при грузе у края до ${dMax.toFixed(2)} мм — перестановка груза наклонит плиту, стабилизация это исправит`);
    if (A.backlash > 0.1) add('warn', 'Люфт', `${A.backlash} мм; пока все опоры нагружены на сжатие, люфт выбирается весом, при отрыве опоры — плита «играет»`);

    // 5. Точность горизонта: смещение нуля, температура, разрешение привода
    const dT = Math.abs(plant.tempC - 20);
    const sensAcc = 2 * Math.hypot(S.biasDeg, S.tempCoef * dT) + S.resolutionDeg;
    const lever = Math.min(...cfg.supports.map((s, i) => {
      const o = cfg.supports.filter((_, j) => j !== i);
      const dx = o[1].x - o[0].x, dy = o[1].y - o[0].y;
      return Math.abs(dx * (o[0].y - s.y) - dy * (o[0].x - s.x)) / Math.hypot(dx, dy);
    }));
    const actAcc = Math.atan(ctrl._posTol() / lever) / DEG;
    const acc = Math.hypot(sensAcc, actAcc);
    const tol = ctrl.params.tolDeg;
    add(acc <= tol ? 'ok' : acc <= 2 * tol ? 'warn' : 'bad', 'Точность горизонта',
      `≈±${acc.toFixed(3)}° (±${(Math.tan(acc * DEG) * 1000).toFixed(2)} мм на 1 м): датчики ±${sensAcc.toFixed(3)}°${dT ? ` при ${plant.tempC} °C` : ''}, привод ±${actAcc.toFixed(3)}°; допуск ${tol}°`);
    if (A.vMin) add('warn', 'Режим выравнивания', `привод не едет медленнее ${A.vMin} мм/с — выравнивание шагами «ход → замер», дольше`);

    // 6. Резервирование датчиков
    const n = cfg.sensorCount || 3;
    add(n >= 3 ? 'ok' : n === 2 ? 'warn' : 'bad', 'Резервирование',
      n >= 3 ? '3 датчика: неисправный исключается голосованием 2 из 3, работа продолжается'
        : n === 2 ? '2 датчика: расхождение заметно, но не понять, кто врёт — только аварийная остановка'
          : '1 датчик: дрейф или смещение не обнаружить — плита тихо уйдёт из горизонта');

    // 7. Высота
    add(plant.hasHeightSensor ? 'ok' : 'warn', 'Высота',
      plant.hasHeightSensor ? `датчик высоты: абсолютная высота ±${(cfg.heightSensor.noise * 2).toFixed(2)} мм` : 'по энкодерам: не учтены неровность пола и просадка опор (ошибка — миллиметры)');

    // 8. Скорость подъёма
    const H = ctrl.params.targetHeight - (A.bodyLength + P.thickness);
    add('ok', 'Подъём', `с нижнего положения на ${ctrl.params.targetHeight} мм ≈${(H / C.vMove + C.vMove / C.aMove).toFixed(0)} с (${C.vMove} мм/с)`);

    // 9. Механика, которую датчики не исправят
    add('warn', 'Боковая жёсткость', 'три штока на шарнирах не держат плиту вбок и от поворота — нужны направляющие или крепление «сфера–паз–плоскость»');

    const holdsDead = (A.selfLocking || A.brake) && !A.leak && acc <= tol && n >= 3;
    return { items: out, holdsDead, accuracy: acc };
  }

  LP.hardware.assess = assess;
})(typeof window !== 'undefined' ? window : globalThis);
