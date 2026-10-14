#include "leveler_core.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace lev {

static const double RAD2DEG = 57.29577951308232;

Vec3 applyMount(const Vec3& s, const Mount& m) {
  Vec3 r = s;
  switch (((m.rot % 360) + 360) % 360) {
    case 90: r.x = -s.y; r.y = s.x; break;
    case 180: r.x = -s.x; r.y = -s.y; break;
    case 270: r.x = s.y; r.y = -s.x; break;
    default: break;
  }
  if (m.flipX) r.x = -r.x;
  if (m.flipY) r.y = -r.y;
  return r;
}

void tiltFromAccel(const Vec3& a, double& tiltX, double& tiltY) {
  const double x = a.x, y = a.y, z = a.z;
  tiltX = atan2(x, sqrt(y * y + z * z)) * RAD2DEG;
  tiltY = atan2(y, sqrt(x * x + z * z)) * RAD2DEG;
}

namespace scl3300 {
uint8_t crc8(uint32_t frame) {
  uint8_t crc = 0xFF;
  for (int bit = 31; bit > 7; bit--) {
    uint8_t bv = (uint8_t)((frame >> bit) & 0x01);
    uint8_t temp = (uint8_t)(crc & 0x80);
    if (bv) temp ^= 0x80;
    crc = (uint8_t)(crc << 1);
    if (temp) crc ^= 0x1D;
  }
  return (uint8_t)~crc;
}

bool decode(uint32_t frame, int& rs, int16_t& data) {
  rs = (int)((frame >> 24) & 0x03);
  data = (int16_t)((frame >> 8) & 0xFFFF);
  return crc8(frame) == (uint8_t)(frame & 0xFF);
}
}  // namespace scl3300

FusionParams defaultParams() {
  FusionParams p;
  p.tau = 0.5f;
  p.faultDeg = 0.1f;
  p.faultTime = 0.5f;
  p.noiseFaultDeg = 0.08f;
  p.stuckTime = 2.0f;
  p.resolution = 0.001f;
  return p;
}

double median3(double a, double b, double c) {
  double lo = a < b ? a : b, hi = a < b ? b : a;
  double m = hi < c ? hi : c;
  return lo > m ? lo : m;
}

static void resetSensor(SensorState& s, bool keepOffsets) {
  double ox = s.offX, oy = s.offY;
  bool present = s.present;
  memset(&s, 0, sizeof(s));
  s.present = present;
  s.healthy = true;
  if (keepOffsets) {
    s.offX = ox;
    s.offY = oy;
  }
}

Fusion::Fusion() : p_(defaultParams()), n_(MAX_SENSORS), pairPrevValid_(false), pairNoise_(0), pairT_(0), lastUsed_(-1), pendingDt_(0) {
  memset(&f_, 0, sizeof(f_));
  for (int i = 0; i < MAX_SENSORS; i++) {
    memset(&s_[i], 0, sizeof(SensorState));
    s_[i].healthy = true;
  }
}

void Fusion::setCount(int n) { n_ = n < 1 ? 1 : (n > MAX_SENSORS ? MAX_SENSORS : n); }

void Fusion::setPresent(int i, bool present) {
  s_[i].present = present;
  if (!present) exclude(i, "нет датчика");
}

void Fusion::exclude(int i, const char* why) {
  SensorState& s = s_[i];
  if (!s.healthy) return;
  s.healthy = false;
  strncpy(s.reason, why, sizeof(s.reason) - 1);
  s.reason[sizeof(s.reason) - 1] = 0;
}

bool Fusion::othersRef(int i, double& rx, double& ry) const {
  int k = 0;
  rx = ry = 0;
  for (int j = 0; j < n_; j++) {
    if (j == i || !s_[j].present || !s_[j].healthy || !s_[j].init) continue;
    rx += s_[j].ux;
    ry += s_[j].uy;
    k++;
  }
  if (!k) return false;
  rx /= k;
  ry /= k;
  return true;
}

void Fusion::update(int i, bool ok, double tx, double ty, float tempC) {
  SensorState& s = s_[i];
  s.readOk = ok;
  if (!ok) {
    if (++s.errors > 10) exclude(i, "нет связи");
    return;
  }
  s.errors = 0;
  s.tempC = tempC;
  s.rawX = tx - s.offX;
  s.rawY = ty - s.offY;
  if (!s.init) {
    s.ux = tx;
    s.uy = ty;
    s.lastX = tx;
    s.lastY = ty;
    s.init = true;
  } else {
    const double dt = pendingDt_ > 0 ? pendingDt_ : 0.01;
    const double a = dt / (p_.tau + dt);
    s.ux += a * (tx - s.ux);
    s.uy += a * (ty - s.uy);
    const bool same = tx == s.lastX && ty == s.lastY;
    if (same && s.sameT == 0) s.sameRefValid = othersRef(i, s.sameRefX, s.sameRefY);
    s.sameT = same ? s.sameT + (float)dt : 0;
    if (s.sameT > p_.stuckTime && s.sameRefValid) {
      double rx, ry;
      if (othersRef(i, rx, ry) && (fabs(rx - s.sameRefX) > 2 * p_.resolution || fabs(ry - s.sameRefY) > 2 * p_.resolution)) exclude(i, "зависание");
    }
    s.lastX = tx;
    s.lastY = ty;
  }
  s.x = s.ux - s.offX;
  s.y = s.uy - s.offY;
}

void Fusion::fuse() {
  const double dt = pendingDt_ > 0 ? pendingDt_ : 0.01;
  int ok[MAX_SENSORS], k = 0;
  for (int i = 0; i < n_; i++) {
    const SensorState& s = s_[i];
    if (s.present && s.healthy && s.init && s.readOk) ok[k++] = i;
  }
  if (k != lastUsed_) {
    // состав исправных датчиков изменился — оценки шума начинаем заново
    lastUsed_ = k;
    for (int i = 0; i < MAX_SENSORS; i++) s_[i].hasPrevRes = false;
    pairPrevValid_ = false;
  }
  const double beta = dt / (1.0 + dt);

  if (k == 3) {
    SensorState &a = s_[ok[0]], &b = s_[ok[1]], &c = s_[ok[2]];
    const double mx = median3(a.x, b.x, c.x), my = median3(a.y, b.y, c.y);
    const double rx = median3(a.rawX, b.rawX, c.rawX), ry = median3(a.rawY, b.rawY, c.rawY);
    for (int q = 0; q < 3; q++) {
      SensorState& s = s_[ok[q]];
      // шум — по остатку «датчик минус медиана»: общее движение платформы вычитается
      const double res0 = s.rawX - rx, res1 = s.rawY - ry;
      if (s.hasPrevRes) {
        double d0 = fabs(res0 - s.prevRes[0]), d1 = fabs(res1 - s.prevRes[1]);
        s.noise += (float)(beta * ((d0 > d1 ? d0 : d1) - s.noise));
      }
      s.prevRes[0] = res0;
      s.prevRes[1] = res1;
      s.hasPrevRes = true;
      // медленно отслеживаем собственное смещение датчика (температура) — τ 30 с
      const double kb = dt / (30.0 + dt);
      s.relBias[0] += kb * (s.x - mx - s.relBias[0]);
      s.relBias[1] += kb * (s.y - my - s.relBias[1]);
      const double dx = fabs(s.x - s.relBias[0] - mx), dy = fabs(s.y - s.relBias[1] - my);
      const double dev = dx > dy ? dx : dy;
      s.devT = dev > p_.faultDeg ? s.devT + (float)dt : 0;
      if (s.devT > p_.faultTime) exclude(ok[q], "расхождение");
      else if (s.noise > p_.noiseFaultDeg) exclude(ok[q], "шум");
    }
    f_.x = mx;
    f_.y = my;
    f_.valid = true;
    f_.used = 3;
    pairT_ = 0;
  } else if (k == 2) {
    // двое не могут «проголосовать»: при расхождении или шуме — недостоверно
    const SensorState &p = s_[ok[0]], &q = s_[ok[1]];
    const double d0 = fabs(p.x - q.x), d1 = fabs(p.y - q.y);
    const double dis = d0 > d1 ? d0 : d1;
    const double diff0 = p.rawX - q.rawX, diff1 = p.rawY - q.rawY;
    if (pairPrevValid_) {
      double e0 = fabs(diff0 - pairPrev_[0]), e1 = fabs(diff1 - pairPrev_[1]);
      pairNoise_ += (float)(beta * ((e0 > e1 ? e0 : e1) / 2 - pairNoise_));
    }
    pairPrev_[0] = diff0;
    pairPrev_[1] = diff1;
    pairPrevValid_ = true;
    const bool bad = dis > p_.faultDeg || pairNoise_ > p_.noiseFaultDeg;
    pairT_ = bad ? pairT_ + (float)dt : 0;
    f_.x = (p.x + q.x) / 2;
    f_.y = (p.y + q.y) / 2;
    f_.valid = pairT_ <= p_.faultTime;
    f_.used = 2;
  } else if (k == 1 && n_ == 1) {
    // один датчик: голосовать не с кем, смещение и дрейф не обнаружить
    const SensorState& s = s_[ok[0]];
    f_.x = s.x;
    f_.y = s.y;
    f_.valid = true;
    f_.used = 1;
  } else {
    f_.valid = false;
    f_.used = k;
  }
}

void Fusion::setOffsets(int i, double ox, double oy) {
  s_[i].offX = ox;
  s_[i].offY = oy;
  s_[i].x = s_[i].ux - ox;
  s_[i].y = s_[i].uy - oy;
}

void Fusion::zeroAll() {
  for (int i = 0; i < n_; i++)
    if (s_[i].init) setOffsets(i, s_[i].ux, s_[i].uy);
}

void Fusion::clearOffsets() {
  for (int i = 0; i < MAX_SENSORS; i++) setOffsets(i, 0, 0);
}

void Fusion::resetHealth() {
  for (int i = 0; i < MAX_SENSORS; i++) {
    bool present = s_[i].present;
    resetSensor(s_[i], true);
    s_[i].present = present;
    if (!present) exclude(i, "нет датчика");
  }
  lastUsed_ = -1;
  pairT_ = 0;
  pairNoise_ = 0;
  pairPrevValid_ = false;
}

// ================= самовыравнивание =================
LevelerParams defaultLevelerParams() {
  LevelerParams p;
  p.ki = 1.0f;
  p.kh = 0.5f;
  p.tol = 0.02f;
  p.restart = 0.05f;
  p.confirm = 1.0f;
  p.vMax = 5.0f;
  p.zMax = 10.0f;
  return p;
}

Leveler::Leveler() : n_(3), p_(defaultLevelerParams()), auto_(false), h_(0), okT_(0), st_(LV_MANUAL) {
  for (int i = 0; i < MAX_SENSORS; i++) {
    z_[i] = 0;
    pos_[i][0] = pos_[i][1] = 0;
  }
}

void Leveler::setGeometry(const float pos[][2], int n) {
  n_ = n < 3 ? n : 3;
  for (int i = 0; i < n_; i++) {
    pos_[i][0] = pos[i][0];
    pos_[i][1] = pos[i][1];
  }
}

static float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

void Leveler::setAuto(bool on) {
  auto_ = on;
  okT_ = 0;
  st_ = on ? LV_LEVELING : LV_MANUAL;
}

void Leveler::setHeight(float h) { h_ = clampf(h, -p_.zMax, p_.zMax); }

void Leveler::setManual(int i, float z) {
  if (i < 0 || i >= n_) return;
  auto_ = false;
  st_ = LV_MANUAL;
  z_[i] = clampf(z, -p_.zMax, p_.zMax);
}

void Leveler::home() {
  auto_ = false;
  st_ = LV_MANUAL;
  h_ = 0;
  for (int i = 0; i < MAX_SENSORS; i++) z_[i] = 0;
}

void Leveler::update(double dt, bool valid, double tiltX, double tiltY) {
  if (!auto_) return;
  if (!valid) {
    st_ = LV_NO_DATA;  // без достоверного наклона опоры стоят
    okT_ = 0;
    return;
  }
  const double err = fabs(tiltX) > fabs(tiltY) ? fabs(tiltX) : fabs(tiltY);
  if (st_ == LV_LEVEL) {
    // ровно: опоры не дёргаем, пока наклон не уйдёт за порог (без «охоты» на шум)
    if (err <= p_.restart) return;
    st_ = LV_LEVELING;
  }
  const double a = tan(tiltX / RAD2DEG), b = tan(tiltY / RAD2DEG);
  double mean = 0;
  for (int i = 0; i < n_; i++) mean += z_[i];
  mean /= n_;
  bool limited = false;
  for (int i = 0; i < n_; i++) {
    const double eps = a * pos_[i][0] + b * pos_[i][1];  // мм
    double dz = (-p_.ki * eps + p_.kh * (h_ - mean)) * dt;
    const double lim = p_.vMax * dt;
    if (dz > lim) dz = lim;
    if (dz < -lim) dz = -lim;
    float nz = (float)(z_[i] + dz);
    if (nz > p_.zMax || nz < -p_.zMax) limited = true;
    z_[i] = clampf(nz, -p_.zMax, p_.zMax);
  }
  if (limited) {
    st_ = LV_LIMIT;  // не хватает хода рычагов — подложите что-нибудь под низкую сторону
    okT_ = 0;
    return;
  }
  st_ = LV_LEVELING;
  okT_ = err <= p_.tol ? okT_ + (float)dt : 0;
  if (okT_ >= p_.confirm) st_ = LV_LEVEL;
}

double leverAngle(double z, double L) {
  double s = z / L;
  if (s > 1) s = 1;
  if (s < -1) s = -1;
  return asin(s) * RAD2DEG;
}

void planeTilt(const float pos[][2], const float z[3], double& tiltX, double& tiltY) {
  const double ux = pos[1][0] - pos[0][0], uy = pos[1][1] - pos[0][1], uz = z[1] - z[0];
  const double vx = pos[2][0] - pos[0][0], vy = pos[2][1] - pos[0][1], vz = z[2] - z[0];
  const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  tiltX = atan(-nx / nz) * RAD2DEG;
  tiltY = atan(-ny / nz) * RAD2DEG;
}

static bool wordIs(const char* s, size_t n, const char* w) { return strlen(w) == n && strncmp(s, w, n) == 0; }

Command parseCommand(const char* line) {
  Command c;
  c.type = CMD_NONE;
  c.nv = 0;
  while (*line == ' ' || *line == '\t') line++;
  const char* end = line;
  while (*end && *end != ' ' && *end != '\t' && *end != '\r' && *end != '\n') end++;
  const size_t n = (size_t)(end - line);
  if (!n) return c;
  if (wordIs(line, n, "info")) c.type = CMD_INFO;
  else if (wordIs(line, n, "zero")) c.type = CMD_ZERO;
  else if (wordIs(line, n, "clear")) c.type = CMD_CLEAR;
  else if (wordIs(line, n, "offsets")) c.type = CMD_OFFSETS;
  else if (wordIs(line, n, "tau")) c.type = CMD_TAU;
  else if (wordIs(line, n, "rate")) c.type = CMD_RATE;
  else if (wordIs(line, n, "reset")) c.type = CMD_RESET;
  else if (wordIs(line, n, "sim")) c.type = CMD_SIM;
  else if (wordIs(line, n, "auto")) c.type = CMD_AUTO;
  else if (wordIs(line, n, "home")) c.type = CMD_HOME;
  else if (wordIs(line, n, "height")) c.type = CMD_HEIGHT;
  else if (wordIs(line, n, "servo")) c.type = CMD_SERVO;
  else if (wordIs(line, n, "ki")) c.type = CMD_KI;
  else if (wordIs(line, n, "tol")) c.type = CMD_TOL;
  else {
    c.type = CMD_UNKNOWN;
    return c;
  }
  const char* p = end;
  while (c.nv < 6) {
    char* q = NULL;
    double v = strtod(p, &q);
    if (q == p) break;
    c.v[c.nv++] = v;
    p = q;
  }
  // проверка числа аргументов
  const bool one = c.type == CMD_TAU || c.type == CMD_RATE || c.type == CMD_AUTO || c.type == CMD_HEIGHT || c.type == CMD_KI || c.type == CMD_TOL;
  if ((c.type == CMD_OFFSETS && c.nv != 2 * MAX_SENSORS) || (one && c.nv != 1) || ((c.type == CMD_SIM || c.type == CMD_SERVO) && c.nv != 2))
    c.type = CMD_UNKNOWN;
  return c;
}

int formatState(char* out, size_t cap, uint32_t tMs, const Fusion& fu, float sampleHz, const char* sensorType, const Leveler* lv) {
  size_t len = 0;
#define APPEND(...)                                                                         \
  do {                                                                                      \
    int w = snprintf(out + len, len < cap ? cap - len : 0, __VA_ARGS__);                    \
    if (w > 0) len += (size_t)w;                                                            \
  } while (0)
  APPEND("{\"t\":%lu,\"type\":\"%s\",\"hz\":%.1f,\"n\":%d,\"s\":[", (unsigned long)tMs, sensorType, sampleHz, fu.count());
  for (int i = 0; i < fu.count(); i++) {
    const SensorState& s = fu.sensor(i);
    APPEND("%s{\"p\":%d,\"ok\":%d,\"h\":%d,\"x\":%.5f,\"y\":%.5f,\"ux\":%.5f,\"uy\":%.5f,\"tc\":%.1f,\"nz\":%.5f,\"r\":\"%s\"}", i ? "," : "",
           s.present ? 1 : 0, s.readOk ? 1 : 0, s.healthy ? 1 : 0, s.x, s.y, s.ux, s.uy, s.tempC, s.noise, s.healthy ? "" : s.reason);
  }
  const Fused& f = fu.fused();
  APPEND("],\"f\":{\"x\":%.5f,\"y\":%.5f,\"v\":%d,\"u\":%d}", f.x, f.y, f.valid ? 1 : 0, f.used);
  if (lv) {
    APPEND(",\"m\":{\"auto\":%d,\"st\":%d,\"h\":%.3f,\"z\":[%.4f,%.4f,%.4f]}", lv->isAuto() ? 1 : 0, lv->state(), lv->height(), lv->z(0), lv->z(1), lv->z(2));
  }
  APPEND("}");
#undef APPEND
  if (len >= cap && cap) out[cap - 1] = 0;
  return (int)(len < cap ? len : cap - 1);
}

}  // namespace lev
