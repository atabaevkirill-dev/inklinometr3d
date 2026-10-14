/* Живые данные тестовой платформы: подключение, отображение, подсказки по винтам, калибровка, запись. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const DEG = Math.PI / 180;
  const PLATE = 200; // мм
  const IDS = ['A', 'B', 'C'];
  const COLORS = ['#4cc2ff', '#f78166', '#d2a8ff'];
  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem('live.' + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem('live.' + k, JSON.stringify(v));
      } catch (e) {
        /* хранилище недоступно — не страшно */
      }
    }
  };
  const fs = (v, d) => {
    if (!Number.isFinite(v)) return '—';
    const s = Math.abs(v).toFixed(d);
    return (Number(s) === 0 ? '' : v > 0 ? '+' : '−') + s;
  };

  // ---------- состояние ----------
  let src = null, info = null, last = null, lastAt = 0, t0 = performance.now();
  let rxCount = 0, rxRate = 0, rxT = performance.now();
  const history = [];
  const screws = store.get('screws', [[-85, -85], [85, -85], [0, 85]]);
  let tol = store.get('tol', 0.02), exag = 20;
  let calib = null, cal1 = null, rec = null;

  // ---------- журнал ----------
  function log(text, cls = 'info') {
    const el = $('log'), d = document.createElement('div');
    d.className = cls;
    d.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>`;
    d.appendChild(document.createTextNode(text));
    el.prepend(d);
    while (el.children.length > 120) el.lastChild.remove();
  }

  // ---------- подключение ----------
  const srcSel = $('src'), wsUrl = $('wsUrl'), connBtn = $('connBtn');
  srcSel.value = store.get('src', LP.live.SerialSource.supported() ? 'serial' : 'demo');
  wsUrl.value = store.get('wsUrl', 'ws://leveler.local:81');
  if (!LP.live.SerialSource.supported()) srcSel.querySelector('[value=serial]').textContent = 'USB — нужен Chrome/Edge';
  const showUrl = () => (wsUrl.style.display = srcSel.value === 'ws' ? '' : 'none');
  srcSel.addEventListener('change', () => {
    store.set('src', srcSel.value);
    showUrl();
  });
  wsUrl.addEventListener('change', () => store.set('wsUrl', wsUrl.value.trim()));
  showUrl();

  function setConn(text, cls) {
    const b = $('connState');
    b.textContent = text;
    b.className = 'badge ' + cls;
  }

  async function connect() {
    if (src) return disconnect();
    const kind = srcSel.value;
    const onStatus = (st, msg) => {
      if (st === 'error') log('Ошибка связи: ' + msg, 'error');
      if (st === 'closed' && src) {
        log('Связь закрыта', 'warn');
        src = null;
        setConn('нет связи', 'idle');
        connBtn.textContent = 'Подключить';
      }
    };
    const s = kind === 'serial' ? new LP.live.SerialSource(onLine, onStatus) : kind === 'ws' ? new LP.live.WsSource(onLine, onStatus, wsUrl.value.trim()) : new LP.live.DemoSource(onLine, onStatus);
    setConn('подключаюсь…', 'move');
    try {
      await s.connect();
      src = s;
      document.body.classList.toggle('demo', kind === 'demo');
      if (kind === 'demo') s.setScrews(screws);
      connBtn.textContent = 'Отключить';
      setConn('подключено · ' + s.name, 'ok');
      log(`Подключено: ${s.name}`, 'ok');
      history.length = 0;
      t0 = performance.now();
      if (kind !== 'demo') setTimeout(() => send('info'), 300);
    } catch (e) {
      setConn('ошибка', 'err');
      log(e.message || String(e), 'error');
    }
  }

  async function disconnect() {
    const s = src;
    src = null;
    if (s) await s.disconnect();
    document.body.classList.remove('demo');
    connBtn.textContent = 'Подключить';
    setConn('нет связи', 'idle');
    log('Отключено', 'warn');
  }
  connBtn.addEventListener('click', connect);

  function send(cmd) {
    if (!src) {
      log('Нет связи с платой', 'warn');
      return;
    }
    src.send(cmd);
    log('→ ' + cmd, 'model');
  }

  // ---------- приём ----------
  function onLine(line) {
    if (line[0] !== '{') {
      log(line, 'info'); // отладочный вывод платы
      return;
    }
    let m;
    try {
      m = JSON.parse(line);
    } catch (e) {
      return; // обрывок строки при подключении
    }
    if (m.info) {
      info = m.info;
      $('devInfo').textContent = `${info.type} · ${info.n} шт · ${info.addr || ''}`;
      $('tau').value = info.tau;
      setupServoUi();
      log(`Плата: ${info.board}, прошивка ${info.fw}, датчики ${info.type} ×${info.n}${info.ap ? ', своя точка доступа' : ''}, адрес ${info.addr}`, 'ok');
      return;
    }
    if (m.log) return log('Плата: ' + m.log, 'info');
    if (m.ack) return log('Плата выполнила: ' + m.ack, 'ok');
    if (m.err) return log('Плата: ' + m.err, 'error');
    if (!m.f || !m.s) return;
    last = m;
    lastAt = performance.now();
    rxCount++;
    const t = (lastAt - t0) / 1000;
    history.push({
      t, tx: m.f.v ? m.f.x : NaN, ty: m.f.v ? m.f.y : NaN,
      dev: m.s.map((s) => (s.h && m.f.v ? Math.max(Math.abs(s.x - m.f.x), Math.abs(s.y - m.f.y)) : NaN))
    });
    if (history.length > 4000) history.splice(0, history.length - 4000);
    if (calib) calibSample(m);
    if (rec) rec.rows.push([t.toFixed(3), m.f.x, m.f.y, m.f.v, ...m.s.flatMap((s) => [s.x, s.y]), ...m.s.map((s) => s.tc)]);
  }

  // ---------- наклон и подсказки ----------
  const DIRS = ['вправо', 'вправо-назад', 'назад', 'влево-назад', 'влево', 'влево-вперёд', 'вперёд', 'вправо-вперёд'];

  function corrections(fx, fy) {
    const a = Math.tan(fx * DEG), b = Math.tan(fy * DEG);
    const eps = screws.map(([x, y]) => a * x + b * y); // насколько опора выше горизонта, мм
    const ref = $('ref').value;
    let d;
    if (ref === 'raise') d = eps.map((e) => Math.max(...eps) - e);
    else if (ref === 'center') d = eps.map((e) => -e);
    else {
      const k = IDS.indexOf(ref);
      d = eps.map((e) => eps[k] - e);
    }
    return d; // сколько поднять (+) / опустить (−) каждую опору, мм
  }

  function renderScrews(fx, fy, valid) {
    const pitch = Number($('pitch').value);
    const level = valid && Math.max(Math.abs(fx), Math.abs(fy)) <= tol;
    const d = valid ? corrections(fx, fy) : [NaN, NaN, NaN];
    $('screws').innerHTML = d
      .map((v, i) => {
        const turns = v / pitch, small = Math.abs(v) < 0.005;
        const cls = !valid ? '' : level || small ? 'ok' : v > 0 ? 'up' : 'down';
        const what = !valid ? 'нет данных' : level ? 'ровно ✓' : small ? 'не трогать'
          : `<b>${v > 0 ? '↑ поднять' : '↓ опустить'} на ${Math.abs(v).toFixed(3)} мм</b><small>≈ ${Math.abs(turns).toFixed(2)} оборота (${Math.round(Math.abs(turns) * 360)}°)</small>`;
        return `<div class="screw ${cls}"><span class="id" style="color:${COLORS[i]}">${IDS[i]}</span><span class="what">${what}</span>
          <span class="demo-btns demo-only"><button class="btn" data-turn="${i}" data-mm="${(-pitch / 4).toFixed(4)}">−¼</button><button class="btn" data-turn="${i}" data-mm="${(pitch / 4).toFixed(4)}">+¼</button><button class="btn" data-turn="${i}" data-mm="${Number.isFinite(v) ? (v * (0.9 + Math.random() * 0.2)).toFixed(4) : 0}" title="Повернуть как в подсказке (с ошибкой ±10%)">✓</button></span></div>`;
      })
      .join('');
  }
  $('screws').addEventListener('click', (e) => {
    const b = e.target.closest('[data-turn]');
    if (b && src && src.turn) src.turn(Number(b.dataset.turn), Number(b.dataset.mm));
  });

  // положение опор — редактируемое
  $('screwPos').innerHTML = screws
    .map((p, i) => `<label class="fld">${IDS[i]} x <input type="number" step="5" data-s="${i}" data-k="0" value="${p[0]}"></label>`
      + `<label class="fld">${IDS[i]} y <input type="number" step="5" data-s="${i}" data-k="1" value="${p[1]}"></label>`)
    .join('');
  $('screwPos').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset.s) return;
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    screws[el.dataset.s][el.dataset.k] = Math.max(-PLATE / 2, Math.min(PLATE / 2, v));
    store.set('screws', screws);
    if (src && src.setScrews) src.setScrews(screws);
    if (view) view.placeScrews();
  });

  // ---------- сервоприводы ----------
  const LV_STATE = [['ручной', 'idle'], ['выравнивание…', 'level'], ['ровно — удержание', 'ok'], ['не хватает хода', 'err'], ['нет данных', 'err']];
  function setupServoUi() {
    const sv = info && info.servo;
    $('servoNone').classList.toggle('hidden', !!sv);
    $('servoUi').classList.toggle('hidden', !sv);
    if (!sv) return;
    const zm = sv.zmax;
    $('hRange').min = -zm;
    $('hRange').max = zm;
    $('servoRows').innerHTML = [0, 1, 2]
      .map((i) => `<div class="servo-row"><span class="id" style="color:${COLORS[i]}">${IDS[i]}</span>
        <input type="range" min="${-zm}" max="${zm}" step="0.05" value="0" data-servo="${i}">
        <span class="val" id="sv${i}">—</span></div>`)
      .join('');
    $('servoNote').textContent = `Сервы: ${sv.type}, рычаг ${sv.lever} мм, ход ±${zm.toFixed(1)} мм. В авто ползунки показывают, куда сервы подняли опоры; при выключенном авто ими можно двигать вручную.`;
    send('tol ' + tol);
  }
  $('servoRows').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.servo !== undefined) send(`servo ${el.dataset.servo} ${Number(el.value).toFixed(2)}`);
  });
  $('autoBtn').addEventListener('click', () => send(last && last.m && last.m.auto ? 'auto 0' : 'auto 1'));
  $('homeBtn').addEventListener('click', () => send('home'));
  $('hRange').addEventListener('input', () => ($('hVal').textContent = Number($('hRange').value).toFixed(1)));
  $('hRange').addEventListener('change', () => send('height ' + Number($('hRange').value).toFixed(2)));
  function renderServos(m) {
    if (!m || !info || !info.servo) return;
    const [txt, cls] = LV_STATE[m.st] || ['—', 'idle'];
    $('lvState').textContent = txt;
    $('lvState').className = 'badge ' + cls;
    $('autoBtn').textContent = m.auto ? '■ Выключить авто' : '▶ Включить авто';
    const L = info.servo.lever;
    m.z.forEach((z, i) => {
      const r = document.querySelector(`[data-servo="${i}"]`);
      if (r) {
        r.disabled = !!m.auto;
        if (m.auto || document.activeElement !== r) r.value = z;
      }
      const el = $('sv' + i);
      if (el) el.textContent = `${fs(z, 2)} мм · ${fs((Math.asin(Math.max(-1, Math.min(1, z / L))) * 180) / Math.PI, 1)}°`;
    });
    if (document.activeElement !== $('hRange')) {
      $('hRange').value = m.h;
      $('hVal').textContent = m.h.toFixed(1);
    }
  }

  // ---------- калибровка ----------
  function startCalib(phase) {
    if (!last) return log('Нет данных с датчиков', 'warn');
    calib = { phase, until: performance.now() + 3000, acc: last.s.map(() => [0, 0, 0]) };
    $('calMsg').textContent = `Замер ${phase === 1 ? 1 : 2}: 3 секунды, платформу не трогайте…`;
  }
  function calibSample(m) {
    m.s.forEach((s, i) => {
      if (s.ok) {
        calib.acc[i][0] += s.ux;
        calib.acc[i][1] += s.uy;
        calib.acc[i][2]++;
      }
    });
    if (performance.now() < calib.until) return;
    const avg = calib.acc.map(([x, y, n]) => (n ? [x / n, y / n] : [NaN, NaN]));
    const phase = calib.phase;
    calib = null;
    if (phase === 1) {
      cal1 = avg;
      $('cal2').disabled = false;
      $('calMsg').innerHTML = '<b>Теперь разверните платформу на 180° на том же месте</b> и нажмите «2. Замер».';
      return;
    }
    // m1 = s + b, m2 = −s + b → смещение датчика b = (m1 + m2)/2, наклон стола s = (m1 − m2)/2
    const off = avg.map((m2, i) => [(cal1[i][0] + m2[0]) / 2, (cal1[i][1] + m2[1]) / 2]);
    const table = avg.map((m2, i) => [(cal1[i][0] - m2[0]) / 2, (cal1[i][1] - m2[1]) / 2]);
    const med = (k) => table.map((v) => v[k]).filter(Number.isFinite).sort((a, b) => a - b)[Math.floor(table.length / 2)];
    while (off.length < 3) off.push([0, 0]);
    send('offsets ' + off.flat().map((v) => (Number.isFinite(v) ? v.toFixed(5) : '0')).join(' '));
    $('calMsg').innerHTML = `Готово. Смещения датчиков: ${off.slice(0, avg.length).map((o, i) => `${i + 1}: ${fs(o[0], 3)}/${fs(o[1], 3)}°`).join(', ')}.
      Наклон стола: X ${fs(med(0), 3)}°, Y ${fs(med(1), 3)}°.`;
    cal1 = null;
    $('cal2').disabled = true;
    log('Калибровка разворотом записана в плату', 'ok');
  }
  $('cal1').addEventListener('click', () => startCalib(1));
  $('cal2').addEventListener('click', () => startCalib(2));
  $('zeroBtn').addEventListener('click', () => send('zero'));
  $('clearBtn').addEventListener('click', () => send('clear'));
  $('rotBtn').addEventListener('click', () => src && src.rotate && (src.rotate(), log('Демо: платформа развёрнута на 180°', 'model')));
  $('resetBtn').addEventListener('click', () => send('reset'));

  // ---------- настройки ----------
  $('tol').value = tol;
  $('tol').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v > 0) {
      tol = v;
      store.set('tol', v);
      if (src && info && info.servo) send('tol ' + v);
    } else e.target.value = tol;
  });
  $('tau').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0.05 && v <= 5) send('tau ' + v);
  });
  $('exag').addEventListener('input', (e) => {
    exag = Number(e.target.value);
    $('exagVal').textContent = exag;
  });
  const sendCmd = () => {
    const c = $('cmd').value.trim();
    if (c) send(c);
    $('cmd').value = '';
  };
  $('cmdBtn').addEventListener('click', sendCmd);
  $('cmd').addEventListener('keydown', (e) => e.key === 'Enter' && sendCmd());

  // ---------- запись ----------
  $('recBtn').addEventListener('click', () => {
    if (rec) {
      rec.stopped = true;
      $('recBtn').textContent = '● Начать запись';
      log(`Запись остановлена: ${rec.rows.length} строк`, 'ok');
      const keep = rec;
      rec = null;
      lastRec = keep;
      $('csvBtn').disabled = !keep.rows.length;
    } else {
      rec = { rows: [] };
      $('recBtn').textContent = '■ Остановить';
      $('csvBtn').disabled = true;
      log('Запись началась', 'ok');
    }
  });
  let lastRec = null;
  $('csvBtn').addEventListener('click', () => {
    if (!lastRec) return;
    const n = (lastRec.rows[0] || []).length > 10 ? 3 : 1;
    const head = ['t_s', 'x_deg', 'y_deg', 'valid', ...Array.from({ length: n }, (_, i) => [`s${i + 1}_x`, `s${i + 1}_y`]).flat(), ...Array.from({ length: n }, (_, i) => `s${i + 1}_temp`)];
    const csv = [head.join(','), ...lastRec.rows.map((r) => r.join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `platform-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- 3D ----------
  let view = null;
  function makeView() {
    if (typeof THREE === 'undefined' || !THREE.OrbitControls) {
      $('view3d').innerHTML = '<div class="no3d">3D недоступно (не загрузился three.js)</div>';
      return null;
    }
    const el = $('view3d');
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    el.appendChild(r.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0f14);
    const cam = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    cam.position.set(260, 220, 300);
    const oc = new THREE.OrbitControls(cam, r.domElement);
    oc.target.set(0, 20, 0);
    oc.enableDamping = true;
    oc.update();
    scene.add(new THREE.HemisphereLight(0xc8d8ff, 0x1a1f27, 0.7));
    const dl = new THREE.DirectionalLight(0xffffff, 0.8);
    dl.position.set(200, 400, 150);
    scene.add(dl);
    const grid = new THREE.GridHelper(600, 30, 0x2b3644, 0x1c242e);
    scene.add(grid);
    const plate = new THREE.Group();
    plate.position.y = 30;
    scene.add(plate);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(PLATE, 8, PLATE), new THREE.MeshStandardMaterial({ color: 0x8b96a5, metalness: 0.4, roughness: 0.5 }));
    plate.add(slab);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(PLATE - 2, PLATE - 2), new THREE.MeshStandardMaterial({ color: 0x3ddc84, roughness: 0.7 }));
    top.rotation.x = -Math.PI / 2;
    top.position.y = 4.2;
    plate.add(top);
    const sens = [0, 1, 2].map(() => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(22, 8, 18), new THREE.MeshStandardMaterial({ color: 0x0d1117 }));
      m.position.y = 8;
      plate.add(m);
      return m;
    });
    const feet = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 26, 16), new THREE.MeshStandardMaterial({ color: 0xd8dee6, metalness: 0.8, roughness: 0.3 }));
      m.position.y = -17;
      plate.add(m);
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(7, 14, 16), new THREE.MeshStandardMaterial({ color: COLORS[i], emissive: COLORS[i], emissiveIntensity: 0.4 }));
      plate.add(arrow);
      return { m, arrow };
    });
    const v = {
      placeScrews() {
        feet.forEach((f, i) => {
          f.m.position.x = screws[i][0];
          f.m.position.z = -screws[i][1];
          f.arrow.position.set(screws[i][0], 24, -screws[i][1]);
        });
      },
      update() {
        const valid = last && last.f.v;
        const fx = valid ? last.f.x : 0, fy = valid ? last.f.y : 0;
        let a = Math.tan(fx * DEG) * exag, b = Math.tan(fy * DEG) * exag;
        const mg = Math.hypot(a, b), lim = Math.tan(30 * DEG);
        if (mg > lim) {
          a *= lim / mg;
          b *= lim / mg;
        }
        // поворот плиты: нормаль (−a, −b, 1) в осях three (x, y вверх, −z)
        const n = new THREE.Vector3(-a, 1, b).normalize();
        plate.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        const lvl = valid && Math.max(Math.abs(fx), Math.abs(fy)) <= tol;
        const t = valid ? Math.min(1, Math.max(Math.abs(fx), Math.abs(fy)) / Math.max(tol * 10, 1e-6)) : 1;
        top.material.color.setHSL(valid ? (lvl ? 140 : 50 - 50 * t) / 360 : 0, valid ? 0.7 : 0, 0.42);
        const pos = (info && info.pos) || [[-70, -70], [70, -70], [0, 70]];
        sens.forEach((m, i) => {
          const s = last && last.s[i];
          m.visible = !!pos[i];
          if (pos[i]) m.position.set(pos[i][0], 8, -pos[i][1]);
          m.material.color.setHex(!s ? 0x30363d : s.h ? 0x3ddc84 : 0xff5a5f);
        });
        const d = valid ? corrections(fx, fy) : [0, 0, 0];
        feet.forEach((f, i) => {
          const show = valid && !lvl && Math.abs(d[i]) >= 0.005 && !(last.m && last.m.auto); // в авто винты не трогаем
          f.arrow.visible = show;
          f.arrow.rotation.z = d[i] > 0 ? 0 : Math.PI;
        });
        oc.update();
        r.render(scene, cam);
      },
      resize() {
        const w = el.clientWidth, h = el.clientHeight;
        if (!w || !h) return;
        r.setSize(w, h);
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      }
    };
    v.placeScrews();
    new ResizeObserver(() => v.resize()).observe(el);
    v.resize();
    return v;
  }
  view = makeView();

  // ---------- графики ----------
  const chartTilt = new LP.TimeChart($('chartTilt'), {
    symlog: 0.002, symmetric: true, minSpan: 0.02, digits: 4, band: () => tol,
    series: [{ label: 'X', color: '#4cc2ff', get: (h) => h.tx }, { label: 'Y', color: '#f78166', get: (h) => h.ty }]
  });
  const chartDev = new LP.TimeChart($('chartDev'), {
    minSpan: 0.01, digits: 4,
    series: [0, 1, 2].map((i) => ({ label: `${i + 1}`, color: COLORS[i], get: (h) => h.dev[i] }))
  });

  // ---------- таблица датчиков ----------
  function renderSensors(m) {
    $('sensBody').innerHTML = m.s
      .map((s, i) => `<tr><td><b style="color:${COLORS[i]}">${i + 1}</b></td><td class="num">${s.ok ? fs(s.x, 4) : '—'}</td><td class="num">${s.ok ? fs(s.y, 4) : '—'}</td>
        <td class="num">${s.ok ? s.nz.toFixed(4) : '—'}</td><td class="num">${s.ok ? s.tc.toFixed(1) : '—'}</td>
        <td class="${!s.p ? 'bad' : s.h ? 'good' : 'bad'}" title="${s.r || ''}">${!s.p ? 'не найден' : !s.ok ? 'нет ответа' : s.h ? 'в работе' : 'исключён'}</td></tr>`)
      .join('');
  }

  // ---------- цикл отрисовки ----------
  let uiT = 0;
  function frame(now) {
    if (view) {
      view.update();
    }
    if (now - uiT > 100) {
      uiT = now;
      const age = lastAt ? (now - lastAt) / 1000 : Infinity;
      if (now - rxT > 1000) {
        rxRate = (rxCount * 1000) / (now - rxT);
        rxCount = 0;
        rxT = now;
      }
      $('age').textContent = Number.isFinite(age) ? (age < 1.5 ? 'только что' : `${age.toFixed(0)} с назад`) : '—';
      $('age').className = age < 1.5 ? 'good' : 'bad';
      $('rates').textContent = last ? `${last.hz.toFixed(0)} Гц / ${rxRate.toFixed(0)} Гц` : '—';
      const banner = $('banner');
      if (last && age < 3) {
        const f = last.f, a = Math.tan(f.x * DEG), b = Math.tan(f.y * DEG);
        const lvl = f.v && Math.max(Math.abs(f.x), Math.abs(f.y)) <= tol;
        const cls = (v) => (!f.v ? 'bad' : Math.abs(v) <= tol ? 'good' : Math.abs(v) <= 5 * tol ? 'mid' : 'bad');
        $('fx').textContent = f.v ? fs(f.x, 4) + '°' : '—';
        $('fx').className = cls(f.x);
        $('fy').textContent = f.v ? fs(f.y, 4) + '°' : '—';
        $('fy').className = cls(f.y);
        const tot = Math.atan(Math.hypot(a, b)) / DEG;
        $('ftot').textContent = f.v ? `${tot.toFixed(4)}° (${(Math.hypot(a, b) * 1000).toFixed(2)} мм на 1 м)` : '—';
        const az = ((Math.atan2(b, a) / DEG) + 360) % 360;
        $('fdir').textContent = f.v ? (lvl ? 'ровно ✓' : `${DIRS[Math.round(az / 45) % 8]} (${az.toFixed(0)}°)`) : '—';
        $('fspread').textContent = f.v ? `${(PLATE * (Math.abs(a) + Math.abs(b))).toFixed(3)} мм` : '—';
        $('fused').textContent = `${f.u} из ${last.n}`;
        $('fused').className = f.u === last.n ? 'good' : f.u >= 2 ? 'mid' : 'bad';
        renderSensors(last);
        renderScrews(f.x, f.y, f.v);
        renderServos(last.m);
        const missing = last.s.map((s, i) => (!s.p ? i + 1 : 0)).filter(Boolean);
        const msg = !f.v ? 'Наклон недостоверен: датчики расходятся или не отвечают' : missing.length ? `Датчик ${missing.join(', ')} не найден — проверьте провода` : '';
        banner.textContent = msg;
        banner.classList.toggle('hidden', !msg);
      } else {
        banner.textContent = src ? 'Нет данных от платы' : 'Подключите плату или выберите «Демо без железа»';
        banner.classList.remove('hidden');
        renderScrews(0, 0, false);
      }
      const tNow = (now - t0) / 1000;
      chartTilt.draw(history, tNow);
      chartDev.draw(history, tNow);
      LP.drawBubble($('bubble'), last ? last.f.x : 0, last ? last.f.y : 0, tol, !!(last && last.f.v && age < 3));
      if (rec) $('recInfo').textContent = `${rec.rows.length} строк`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  log('Выберите источник и нажмите «Подключить». Без платы — «Демо без железа».', 'info');
})();
