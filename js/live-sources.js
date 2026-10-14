/* Источники живых данных: USB (Web Serial), Wi-Fi (WebSocket) и демо без железа.
 * Все отдают одинаковые JSON-строки, как прошивка ESP32 (firmware/esp32-leveler), и принимают текстовые команды. */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});
  const BAUD = 230400;

  class SerialSource {
    constructor(onLine, onStatus) {
      this.onLine = onLine;
      this.onStatus = onStatus;
      this.name = 'USB';
    }
    static supported() {
      return 'serial' in navigator;
    }
    async connect() {
      if (!SerialSource.supported()) throw new Error('Web Serial не поддерживается — нужен Chrome или Edge');
      this.port = await navigator.serial.requestPort();
      await this.port.open({ baudRate: BAUD });
      this.writer = this.port.writable.getWriter();
      this._read();
    }
    async _read() {
      const dec = new TextDecoderStream();
      this.piped = this.port.readable.pipeTo(dec.writable).catch(() => {});
      this.reader = dec.readable.getReader();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) this.onLine(line);
          }
          if (buf.length > 20000) buf = '';
        }
      } catch (e) {
        this.onStatus('error', e.message);
      }
      this.onStatus('closed');
    }
    send(text) {
      if (this.writer) this.writer.write(new TextEncoder().encode(text + '\n'));
    }
    async disconnect() {
      try {
        await this.reader.cancel();
        await this.piped;
        this.writer.releaseLock();
        await this.port.close();
      } catch (e) {
        /* порт уже закрыт */
      }
    }
  }

  class WsSource {
    constructor(onLine, onStatus, url) {
      this.onLine = onLine;
      this.onStatus = onStatus;
      this.url = url;
      this.name = 'Wi-Fi';
    }
    connect() {
      return new Promise((resolve, reject) => {
        let opened = false;
        const ws = (this.ws = new WebSocket(this.url));
        const timer = setTimeout(() => {
          if (!opened) {
            ws.close();
            reject(new Error(`нет ответа от ${this.url}`));
          }
        }, 6000);
        ws.onopen = () => {
          opened = true;
          clearTimeout(timer);
          resolve();
        };
        ws.onerror = () => {
          if (!opened) {
            clearTimeout(timer);
            reject(new Error(`не удалось подключиться к ${this.url}`));
          }
        };
        ws.onmessage = (e) => typeof e.data === 'string' && this.onLine(e.data.trim());
        ws.onclose = () => opened && this.onStatus('closed');
      });
    }
    send(text) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(text);
    }
    disconnect() {
      if (this.ws) this.ws.close();
    }
  }

  /* Демо: виртуальная платформа на трёх винтах на слегка наклонном столе.
   * Модель повторяет прошивку: тот же JSON, те же команды. Винты можно «крутить» кнопками. */
  class DemoSource {
    constructor(onLine, onStatus) {
      this.onLine = onLine;
      this.onStatus = onStatus;
      this.name = 'Демо';
      const r = (a, b) => a + Math.random() * (b - a);
      this.table = [r(-0.6, 0.6), r(-0.6, 0.6)]; // наклон стола, °
      this.screws = [[-85, -85], [85, -85], [0, 85]];
      this.h = [0, 0, 0]; // подъём винтов, мм
      this.rot = false;   // платформу развернули на 180°
      this.bias = [0, 1, 2].map(() => [r(-0.15, 0.15), r(-0.15, 0.15)]); // перекос установки датчиков
      this.off = [[0, 0], [0, 0], [0, 0]];
      this.f = null;
      this.tau = 0.5;
      this.rate = 20;
      this.t0 = performance.now();
      // сервоприводы с рычагом 15 мм (как в прошивке по умолчанию)
      this.lever = 15;
      this.lv = { auto: false, st: 0, h: 0, z: [0, 0, 0], okT: 0, tol: 0.02, restart: 0.05, kh: 0.5, vMax: 5, zMax: 15 * Math.sin((50 * Math.PI) / 180) };
      this.za = [0, 0, 0]; // фактическое положение рычагов (серва отрабатывает с запаздыванием)
    }
    connect() {
      this.timer = setInterval(() => this._tick(), 1000 / this.rate);
      setTimeout(() => this._info(), 50);
      return Promise.resolve();
    }
    disconnect() {
      clearInterval(this.timer);
    }
    setScrews(pts) {
      this.screws = pts;
    }
    turn(i, mm) {
      this.h[i] += mm;
    }
    rotate() {
      this.rot = !this.rot;
    }
    // наклон платформы, °: стол + плоскость через три винта
    _plateTilt() {
      const [p, q, s] = this.screws, h = this.h.map((v, i) => v + this.za[i]);
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = h[1] - h[0];
      const vx = s[0] - p[0], vy = s[1] - p[1], vz = h[2] - h[0];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const a = -nx / nz, b = -ny / nz; // dz/dx, dz/dy
      const sg = this.rot ? -1 : 1;
      return [sg * this.table[0] + (Math.atan(a) * 180) / Math.PI, sg * this.table[1] + (Math.atan(b) * 180) / Math.PI];
    }
    _tick() {
      const g = () => {
        let s = 0;
        for (let k = 0; k < 6; k++) s += Math.random();
        return (s - 3) * 1.414;
      };
      const q = (v) => Math.round(v / 0.0055) * 0.0055; // разрешение SCL3300
      const [tx, ty] = this._plateTilt(), dt = 1 / this.rate, al = dt / (this.tau + dt);
      const raw = this.bias.map(([bx, by]) => [q(tx + bx + 0.004 * g()), q(ty + by + 0.004 * g())]);
      if (!this.f) this.f = raw.map((v) => v.slice());
      this.f.forEach((v, i) => {
        v[0] += al * (raw[i][0] - v[0]);
        v[1] += al * (raw[i][1] - v[1]);
      });
      const cal = this.f.map((v, i) => [v[0] - this.off[i][0], v[1] - this.off[i][1]]);
      const med = (k) => cal.map((v) => v[k]).sort((a, b) => a - b)[1];
      const fx = med(0), fy = med(1);
      this._level(dt, fx, fy);
      const msg = {
        t: Math.round(performance.now() - this.t0), type: 'DEMO', hz: 100, n: 3,
        s: cal.map((v, i) => ({ p: 1, ok: 1, h: 1, x: v[0], y: v[1], ux: this.f[i][0], uy: this.f[i][1], tc: 24 + i * 0.4, nz: 0.0045, r: '' })),
        f: { x: fx, y: fy, v: 1, u: 3 },
        m: { auto: this.lv.auto ? 1 : 0, st: this.lv.st, h: this.lv.h, z: this.lv.z.slice() }
      };
      this.onLine(JSON.stringify(msg));
    }
    // регулятор — копия Leveler::update из прошивки
    _level(dt, fx, fy) {
      const L = this.lv, ki = Math.min(1, 0.5 / this.tau);
      if (L.auto) {
        const err = Math.max(Math.abs(fx), Math.abs(fy));
        let skip = false;
        if (L.st === 2) {
          if (err <= L.restart) skip = true;
          else L.st = 1;
        }
        if (!skip) {
          const a = Math.tan((fx * Math.PI) / 180), b = Math.tan((fy * Math.PI) / 180);
          const mean = (L.z[0] + L.z[1] + L.z[2]) / 3;
          let limited = false;
          L.z = L.z.map((z, i) => {
            const eps = a * this.screws[i][0] + b * this.screws[i][1];
            const dz = Math.max(-L.vMax * dt, Math.min(L.vMax * dt, (-ki * eps + L.kh * (L.h - mean)) * dt));
            const nz = z + dz;
            if (Math.abs(nz) > L.zMax) limited = true;
            return Math.max(-L.zMax, Math.min(L.zMax, nz));
          });
          if (limited) {
            L.st = 3;
            L.okT = 0;
          } else {
            L.st = 1;
            L.okT = err <= L.tol ? L.okT + dt : 0;
            if (L.okT >= 1) L.st = 2;
          }
        }
      }
      // серва: угол с шагом 0.088° (энкодер 4096/об), отработка ~0.1 с
      const step = 360 / 4096;
      this.za = this.za.map((za, i) => {
        const ang = Math.round((Math.asin(Math.max(-1, Math.min(1, L.z[i] / this.lever))) * 180) / Math.PI / step) * step;
        const zt = this.lever * Math.sin((ang * Math.PI) / 180);
        return za + (zt - za) * Math.min(1, dt / 0.1);
      });
    }
    _info() {
      this.onLine(JSON.stringify({ info: { fw: 'demo', board: 'браузер', type: 'DEMO', n: 3, tau: this.tau, rate: this.rate, addr: '—', ap: 0, host: 'demo', ws: 0,
        pos: [[-70, -70], [70, -70], [0, 70]], off: this.off, servo: { type: 'SIM', lever: this.lever, zmax: this.lv.zMax, pos: this.screws } } }));
    }
    send(text) {
      const [cmd, ...args] = text.trim().split(/\s+/);
      const nums = args.map(Number);
      const ack = (a) => this.onLine(JSON.stringify({ ack: a }));
      if (cmd === 'info') this._info();
      else if (cmd === 'zero' && this.f) {
        this.off = this.f.map((v) => v.slice());
        ack('zero');
        this._info();
      } else if (cmd === 'clear') {
        this.off = [[0, 0], [0, 0], [0, 0]];
        ack('clear');
        this._info();
      } else if (cmd === 'offsets' && nums.length === 6) {
        this.off = [[nums[0], nums[1]], [nums[2], nums[3]], [nums[4], nums[5]]];
        ack('offsets');
        this._info();
      } else if (cmd === 'tau' && nums.length === 1) {
        this.tau = Math.min(5, Math.max(0.05, nums[0]));
        ack('tau');
      } else if (cmd === 'rate' && nums.length === 1) {
        this.rate = Math.min(50, Math.max(1, nums[0]));
        clearInterval(this.timer);
        this.timer = setInterval(() => this._tick(), 1000 / this.rate);
        ack('rate');
      } else if (cmd === 'reset') ack('reset');
      else if (cmd === 'auto' && nums.length === 1) {
        this.lv.auto = nums[0] !== 0;
        this.lv.st = this.lv.auto ? 1 : 0;
        this.lv.okT = 0;
        ack(this.lv.auto ? 'auto on' : 'auto off');
      } else if (cmd === 'home') {
        Object.assign(this.lv, { auto: false, st: 0, h: 0, z: [0, 0, 0] });
        ack('home');
      } else if (cmd === 'height' && nums.length === 1) {
        this.lv.h = Math.max(-this.lv.zMax, Math.min(this.lv.zMax, nums[0]));
        ack('height');
      } else if (cmd === 'servo' && nums.length === 2 && nums[0] >= 0 && nums[0] < 3) {
        Object.assign(this.lv, { auto: false, st: 0 });
        this.lv.z[nums[0]] = Math.max(-this.lv.zMax, Math.min(this.lv.zMax, nums[1]));
        ack('servo');
      } else if (cmd === 'tol' && nums.length === 1) {
        this.lv.tol = nums[0];
        this.lv.restart = Math.max(0.05, 2.5 * nums[0]);
        ack('tol');
      } else if (cmd === 'ki' && nums.length === 1) ack('ki');
      else this.onLine(JSON.stringify({ err: 'неизвестная команда' }));
    }
  }

  LP.live = { SerialSource, WsSource, DemoSource, BAUD };
})(typeof window !== 'undefined' ? window : globalThis);
