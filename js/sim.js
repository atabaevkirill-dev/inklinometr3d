/* Связка модели и контроллера: физика 200 Гц, контур управления 50 Гц, история 10 Гц. */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});

  class Simulation {
    constructor(cfg, seed = 1) {
      this.cfg = cfg;
      this.plant = new LP.Plant(cfg, seed);
      this.ctrl = new LP.Controller(cfg);
      this.dt = cfg.sim.dt;
      this.ctrlEvery = Math.max(1, Math.round(1 / (cfg.control.rate * this.dt)));
      this.histEvery = Math.max(1, Math.round(0.1 / this.dt));
      this.maxHist = 3000;
      this.n = 0;
      this.history = [];
      this.onControl = null; // хук для тестов: (sim) => void после каждого шага контроллера
    }

    get t() {
      return this.plant.t;
    }

    command(name) {
      this.ctrl.command(name);
      if (name === 'stop') {
        this.plant.setCommands([0, 0, 0]);
        this.plant.powered = false;
      }
    }

    // смена железа на лету: параметры пишутся в общий конфиг, модель и контроллер их подхватывают
    setHardware(sel) {
      LP.hardware.applyHardware(this.cfg, sel);
      this.plant.onHardwareChanged();
      this.ctrl.onHardwareChanged();
    }

    note(msg) {
      this.ctrl.log('model', msg);
    }

    stepOnce() {
      if (this.n % this.ctrlEvery === 0) {
        const m = this.plant.measure();
        this.plant.setCommands(this.ctrl.step(this.ctrlEvery * this.dt, m));
        this.plant.powered = this.ctrl.powered;
        if (this.onControl) this.onControl(this);
      }
      this.plant.step(this.dt);
      this.n++;
      if (this.n % this.histEvery === 0) this._record();
    }

    advance(sec) {
      const N = Math.round(sec / this.dt);
      for (let k = 0; k < N; k++) this.stepOnce();
    }

    runUntil(pred, maxSec) {
      const N = Math.round(maxSec / this.dt);
      for (let k = 0; k < N; k++) {
        this.stepOnce();
        if (k % 10 === 0 && pred(this)) return true;
      }
      return pred(this);
    }

    _record() {
      const p = this.plant, c = this.ctrl;
      this.history.push({
        t: p.t,
        tx: c.tilt.x,
        ty: c.tilt.y,
        h: p.heightCenter,
        target: c.params.targetHeight,
        ext: p.act.map((a) => a.ext)
      });
      if (this.history.length > this.maxHist) this.history.shift();
    }
  }

  LP.Simulation = Simulation;
})(typeof window !== 'undefined' ? window : globalThis);
