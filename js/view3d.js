/* 3D-вид (three.js). Физика: X вправо, Y назад, Z вверх (мм). Three.js: Y вверх.
 * Преобразование: P(x, y, z) → V(x, z, −y).
 */
(function (root) {
  'use strict';
  const LP = (root.LP = root.LP || {});
  if (typeof THREE === 'undefined' || !THREE.OrbitControls) return; // нет three.js — работаем без 3D
  const DEG = Math.PI / 180;
  const UP = new THREE.Vector3(0, 1, 0);

  const P2V = (x, y, z) => new THREE.Vector3(x, z, -y);
  const toV = (p) => new THREE.Vector3(p.x, p.z, -p.y);

  function makeLabel(text, { color = '#e6edf3', border = '#4cc2ff', size = 120 } = {}) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    const r = 30;
    g.beginPath();
    g.moveTo(8 + r, 8);
    g.arcTo(248, 8, 248, 120, r);
    g.arcTo(248, 120, 8, 120, r);
    g.arcTo(8, 120, 8, 8, r);
    g.arcTo(8, 8, 248, 8, r);
    g.closePath();
    g.fillStyle = 'rgba(11,15,20,0.85)';
    g.fill();
    g.lineWidth = 5;
    g.strokeStyle = border;
    g.stroke();
    g.fillStyle = color;
    g.font = 'bold 66px system-ui, -apple-system, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 70);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
    sp.renderOrder = 10;
    sp.scale.set(size, size / 2, 1);
    return sp;
  }

  class View3D {
    constructor(container, cfg) {
      this.cfg = cfg;
      this.container = container;
      this.colorRange = 2; // мм — шкала карты отклонений поверхности
      this.onPick = null;

      const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
      r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      r.shadowMap.enabled = true;
      r.shadowMap.type = THREE.PCFSoftShadowMap;
      container.appendChild(r.domElement);

      this.scene = new THREE.Scene();
      this.scene.background = new THREE.Color(0x0b0f14);
      this.scene.fog = new THREE.Fog(0x0b0f14, 5000, 11000);

      this.camera = new THREE.PerspectiveCamera(38, 1, 10, 30000);
      this.camera.position.set(2000, 1450, 2250);
      const oc = (this.controls = new THREE.OrbitControls(this.camera, r.domElement));
      oc.target.set(0, 420, 0);
      oc.enableDamping = true;
      oc.dampingFactor = 0.08;
      oc.maxPolarAngle = Math.PI * 0.49;
      oc.minDistance = 700;
      oc.maxDistance = 9000;
      oc.update();

      this._lights();
      this._build();

      this.ray = new THREE.Raycaster();
      r.domElement.addEventListener('dblclick', (e) => this._pick(e));
      new ResizeObserver(() => this.resize()).observe(container);
      this.resize();
    }

    _lights() {
      const s = this.scene;
      s.add(new THREE.HemisphereLight(0xc8d8ff, 0x1a1f27, 0.65));
      const d = new THREE.DirectionalLight(0xffffff, 0.85);
      d.position.set(1400, 3200, 1600);
      d.castShadow = true;
      d.shadow.mapSize.set(2048, 2048);
      Object.assign(d.shadow.camera, { left: -1600, right: 1600, top: 1600, bottom: -1600, near: 100, far: 9000 });
      d.shadow.bias = -0.0005;
      s.add(d);
    }

    _build() {
      const cfg = this.cfg, A = cfg.actuator, P = cfg.platform, s = this.scene;

      // пол и сетка 100 мм
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshStandardMaterial({ color: 0x141a22, roughness: 1 }));
      floor.rotation.x = -Math.PI / 2;
      floor.receiveShadow = true;
      s.add(floor);
      const grid = new THREE.GridHelper(4000, 40, 0x2b3644, 0x1c242e);
      grid.position.y = 0.5;
      s.add(grid);

      // опоры: подпятник, корпус, мотор-редуктор, шток
      const matPad = new THREE.MeshStandardMaterial({ color: 0x5b6573, metalness: 0.5, roughness: 0.5 });
      const matRod = new THREE.MeshStandardMaterial({ color: 0xd8dee6, metalness: 0.9, roughness: 0.2 });
      const matMotor = new THREE.MeshStandardMaterial({ color: 0x2f6fb5, metalness: 0.3, roughness: 0.5 });
      this.sup = cfg.supports.map((sp) => {
        const len = Math.hypot(sp.x, sp.y) || 1;
        const o = { rx: sp.x / len, ry: sp.y / len };
        o.pad = new THREE.Mesh(new THREE.CylinderGeometry(85, 100, 12, 32), matPad);
        o.body = new THREE.Mesh(
          new THREE.CylinderGeometry(48, 48, A.bodyLength - 12, 32),
          new THREE.MeshStandardMaterial({ color: 0x3a4554, metalness: 0.6, roughness: 0.4, emissive: 0x000000 })
        );
        o.motor = new THREE.Mesh(new THREE.BoxGeometry(80, 150, 80), matMotor);
        o.rod = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 1, 24), matRod);
        o.label = makeLabel(sp.id, { size: 130 });
        for (const m of [o.pad, o.body, o.motor, o.rod]) {
          m.castShadow = true;
          m.receiveShadow = true;
          s.add(m);
        }
        s.add(o.label);
        return o;
      });

      // плита: группа с началом в центре нижней грани, локальная ось Y — нормаль
      this.platform = new THREE.Group();
      s.add(this.platform);
      const slabGeo = new THREE.BoxGeometry(P.size, P.thickness, P.size);
      const slab = new THREE.Mesh(slabGeo, new THREE.MeshStandardMaterial({ color: 0x7d8896, metalness: 0.45, roughness: 0.45 }));
      slab.position.y = P.thickness / 2;
      slab.castShadow = true;
      slab.receiveShadow = true;
      this.platform.add(slab);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(slabGeo), new THREE.LineBasicMaterial({ color: 0x0b0f14 }));
      edges.position.copy(slab.position);
      this.platform.add(edges);

      // верхняя поверхность — карта отклонений высоты
      const top = (this.topGeo = new THREE.PlaneGeometry(P.size, P.size, 24, 24));
      top.rotateX(-Math.PI / 2);
      top.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(top.attributes.position.count * 3), 3));
      this.topMesh = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.05 }));
      this.topMesh.position.y = P.thickness + 0.6;
      this.topMesh.receiveShadow = true;
      this.platform.add(this.topMesh);

      // инклинометры
      this.sensLabels = [];
      this.sensMeshes = cfg.sensors.map((sn) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(90, 36, 70), new THREE.MeshStandardMaterial({ color: 0x3ddc84, roughness: 0.4, emissive: 0x0a2a18 }));
        m.position.set(sn.x, P.thickness + 18, -sn.y);
        m.castShadow = true;
        this.platform.add(m);
        const lb = makeLabel(sn.id, { size: 100, border: '#3ddc84' });
        lb.position.set(sn.x, P.thickness + 120, -sn.y);
        this.platform.add(lb);
        this.sensLabels.push(lb);
        return m;
      });

      // груз
      this.payload = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xd29922, roughness: 0.6 }));
      this.payload.castShadow = true;
      this.platform.add(this.payload);

      // контур целевой плоскости (уставка высоты)
      const h = P.size / 2;
      const ghostGeo = new THREE.BufferGeometry().setFromPoints([P2V(-h, -h, 0), P2V(h, -h, 0), P2V(h, h, 0), P2V(-h, h, 0)]);
      this.ghost = new THREE.LineLoop(ghostGeo, new THREE.LineBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.55 }));
      s.add(this.ghost);
      this._tmpColor = new THREE.Color();
    }

    update(sim, exag) {
      const p = sim.plant, c = sim.ctrl, cfg = this.cfg, A = cfg.actuator, T = cfg.platform.thickness;

      // визуальное усиление наклона (реальные доли градуса глазом не видны), не более 25°
      let a = p.plane.a * exag, b = p.plane.b * exag;
      const m = Math.hypot(a, b), lim = Math.tan(25 * DEG);
      if (m > lim) {
        a *= lim / m;
        b *= lim / m;
      }
      const n = new THREE.Vector3(-a, -b, 1).normalize();
      const u = new THREE.Vector3(1, 0, a);
      u.addScaledVector(n, -u.dot(n)).normalize();
      const w = new THREE.Vector3().crossVectors(n, u);
      const basis = new THREE.Matrix4().makeBasis(toV(u), toV(n), toV(w).negate());
      this.platform.quaternion.setFromRotationMatrix(basis);
      const origin = new THREE.Vector3(0, 0, p.plane.c);
      // усиленный наклон вращает плиту вокруг центра — поднимаем рендер, чтобы она не уходила в корпуса опор
      const lift = Math.max(0, ...cfg.supports.map((s, i) => p.floor[i] + A.bodyLength + 2 - (p.plane.c + u.z * s.x + w.z * s.y)));
      origin.z += lift;
      this.platform.position.copy(toV(origin));

      cfg.supports.forEach((s, i) => {
        const o = this.sup[i], f = p.floor[i], act = p.act[i];
        o.pad.position.copy(P2V(s.x, s.y, f + 6));
        o.body.position.copy(P2V(s.x, s.y, f + 12 + (A.bodyLength - 12) / 2));
        o.motor.position.copy(P2V(s.x + o.rx * 92, s.y + o.ry * 92, f + 110));
        o.label.position.copy(P2V(s.x + o.rx * 210, s.y + o.ry * 210, f + 170));
        // шток — от корпуса до точки крепления на плите (шарнир)
        const attach = origin.clone().addScaledVector(u, s.x).addScaledVector(w, s.y);
        const top = toV(attach), bottom = P2V(s.x, s.y, f + A.bodyLength);
        const dir = top.clone().sub(bottom);
        const len = Math.max(1, dir.length());
        o.rod.position.copy(bottom).addScaledVector(dir, 0.5);
        o.rod.scale.set(1, len, 1);
        o.rod.quaternion.setFromUnitVectors(UP, dir.normalize());
        const em = o.body.material.emissive;
        if (act.stalled || act.force > A.maxForce) em.setHex(0x7a1010);
        else if (Math.abs(act.vel) > 0.05) em.setHex(act.vel > 0 ? 0x0d4a80 : 0x5a4000);
        else em.setHex(0x000000);
      });

      // цвет поверхности: истинное отклонение высоты от центра плиты, мм
      const pos = this.topGeo.attributes.position, col = this.topGeo.attributes.color, R = this.colorRange, tc = this._tmpColor;
      for (let k = 0; k < pos.count; k++) {
        const dz = p.plane.a * pos.getX(k) + p.plane.b * -pos.getZ(k);
        const t = Math.max(-1, Math.min(1, dz / R));
        const hue = t >= 0 ? 140 - 140 * t : 140 + 90 * -t;
        tc.setHSL(hue / 360, 0.72, 0.42 + 0.08 * Math.abs(t));
        col.setXYZ(k, tc.r, tc.g, tc.b);
      }
      col.needsUpdate = true;

      cfg.sensors.forEach((_, j) => {
        const installed = j < (cfg.sensorCount || 3);
        this.sensMeshes[j].visible = this.sensLabels[j].visible = installed;
        const ok = c.sens[j].healthy;
        this.sensMeshes[j].material.color.setHex(ok ? 0x3ddc84 : 0xff5a5f);
        this.sensMeshes[j].material.emissive.setHex(ok ? 0x0a2a18 : 0x3a0a0a);
      });

      const pl = p.payload;
      this.payload.visible = pl.mass > 0;
      if (pl.mass > 0) {
        const side = 160 + 0.35 * pl.mass, h = side * 0.6;
        this.payload.scale.set(side, h, side);
        this.payload.position.set(pl.x, T + h / 2, -pl.y);
      }

      this.ghost.position.y = c.params.targetHeight;
    }

    render() {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }

    resize() {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }

    _pick(e) {
      const rect = this.renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      this.ray.setFromCamera(ndc, this.camera);
      const hit = this.ray.intersectObject(this.topMesh)[0];
      if (hit && this.onPick) {
        const l = this.platform.worldToLocal(hit.point.clone());
        this.onPick(l.x, -l.z);
      }
    }
  }

  LP.View3D = View3D;
})(typeof window !== 'undefined' ? window : globalThis);
