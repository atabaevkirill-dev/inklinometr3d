// Тесты ядра на компьютере: ./test/host/run.sh
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "leveler_core.h"

using namespace lev;

static int fails = 0, total = 0;
#define CHECK(cond, msg)                              \
  do {                                                \
    total++;                                          \
    if (!(cond)) {                                    \
      fails++;                                        \
      fprintf(stderr, "FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
    }                                                 \
  } while (0)

static const double D2R = 3.14159265358979 / 180.0;

// гравитация в осях датчика, лежащего на платформе с наклоном (tx, ty)
static Vec3 gravity(double tx, double ty) {
  Vec3 g;
  g.x = (float)sin(tx * D2R);
  g.y = (float)sin(ty * D2R);
  g.z = (float)sqrt(1 - g.x * g.x - g.y * g.y);
  return g;
}

// простой ГСЧ для шума
static unsigned rs = 12345;
static double noise(double sigma) {
  double s = 0;
  for (int k = 0; k < 12; k++) {
    rs = rs * 1103515245u + 12345u;
    s += (rs >> 8) / 16777216.0;
  }
  return (s - 6) * sigma;
}
static double q(double v, double res) { return floor(v / res + 0.5) * res; }

static void feed(Fusion& f, const double* tx, const double* ty, int n, double dt) {
  f.setDt(dt);
  for (int i = 0; i < n; i++) f.update(i, true, tx[i], ty[i], 25.0f);
  f.fuse();
}

int main() {
  // CRC команд SCL3300 — младший байт каждой команды должен совпасть с рассчитанным
  const uint32_t cmds[] = {scl3300::READ_ACC_X, scl3300::READ_ACC_Y, scl3300::READ_ACC_Z, scl3300::READ_TEMP, scl3300::READ_STATUS,
                           scl3300::READ_WHOAMI, scl3300::MODE_4, scl3300::ENABLE_ANGLES, scl3300::SW_RESET};
  for (unsigned i = 0; i < sizeof(cmds) / sizeof(cmds[0]); i++) CHECK(scl3300::crc8(cmds[i]) == (cmds[i] & 0xFF), "CRC команды SCL3300");
  {
    uint32_t fr = (0x01u << 24) | (0x1234u << 8);
    fr |= scl3300::crc8(fr);
    int r;
    int16_t d;
    CHECK(scl3300::decode(fr, r, d) && r == 1 && d == 0x1234, "разбор ответа SCL3300");
    CHECK(!scl3300::decode(fr ^ 0x100, r, d), "CRC ловит битую посылку");
  }

  // Знаки наклона и ориентация
  {
    double tx, ty;
    tiltFromAccel(gravity(1.0, 0), tx, ty);
    CHECK(fabs(tx - 1.0) < 1e-4 && fabs(ty) < 1e-4, "+X выше → tiltX = +1°");
    tiltFromAccel(gravity(0, -0.5), tx, ty);
    CHECK(fabs(ty + 0.5) < 1e-4, "задний край ниже → tiltY < 0");
    Mount m = {90, false, false};
    Vec3 s = {0, 1, 0};  // датчик повёрнут на 90°: его +Y смотрит в −X платформы
    Vec3 p = applyMount(s, m);
    CHECK(fabs(p.x + 1) < 1e-6 && fabs(p.y) < 1e-6, "поворот 90°");
    Mount m2 = {180, false, true};
    p = applyMount(s, m2);
    CHECK(fabs(p.y - 1) < 1e-6, "поворот 180° + отражение Y");
  }

  // 3 датчика: один со смещением 0.5° исключается, слитый наклон верный
  {
    Fusion f;
    f.setCount(3);
    for (int i = 0; i < 3; i++) f.setPresent(i, true);
    const double bias[3] = {0.002, -0.003, 0.5};
    for (int k = 0; k < 300; k++) {
      double tx[3], ty[3];
      for (int i = 0; i < 3; i++) {
        tx[i] = q(0.3 + bias[i] + noise(0.004), 0.001);
        ty[i] = q(-0.2 + noise(0.004), 0.001);
      }
      feed(f, tx, ty, 3, 0.01);
    }
    CHECK(!f.sensor(2).healthy && strstr(f.sensor(2).reason, "расхождение"), "датчик со смещением исключён");
    CHECK(f.sensor(0).healthy && f.sensor(1).healthy, "исправные остались");
    CHECK(f.fused().valid && fabs(f.fused().x - 0.3) < 0.01 && fabs(f.fused().y + 0.2) < 0.01, "слитый наклон верный");
  }

  // Общий скачок наклона (резкая просадка) — никого не исключаем
  {
    Fusion f;
    f.setCount(3);
    for (int i = 0; i < 3; i++) f.setPresent(i, true);
    for (int k = 0; k < 400; k++) {
      double base = k < 200 ? 0.0 : 0.7, tx[3], ty[3];
      for (int i = 0; i < 3; i++) {
        tx[i] = q(base + noise(0.004), 0.001);
        ty[i] = q(noise(0.004), 0.001);
      }
      feed(f, tx, ty, 3, 0.01);
    }
    CHECK(f.sensor(0).healthy && f.sensor(1).healthy && f.sensor(2).healthy, "общий скачок не считается отказом");
  }

  // Шумный датчик исключается
  {
    Fusion f;
    f.setCount(3);
    for (int i = 0; i < 3; i++) f.setPresent(i, true);
    for (int k = 0; k < 500; k++) {
      double tx[3], ty[3];
      for (int i = 0; i < 3; i++) {
        double sg = i == 1 ? 0.3 : 0.004;
        tx[i] = q(noise(sg), 0.001);
        ty[i] = q(noise(sg), 0.001);
      }
      feed(f, tx, ty, 3, 0.01);
    }
    CHECK(!f.sensor(1).healthy, "шумный датчик исключён");
  }

  // Зависший датчик исключается, только если остальные двигались
  {
    Fusion f;
    f.setCount(3);
    for (int i = 0; i < 3; i++) f.setPresent(i, true);
    for (int k = 0; k < 400; k++) {
      double tx[3], ty[3], base = 0.002 * k;
      for (int i = 0; i < 3; i++) {
        tx[i] = i == 2 ? 0.123 : q(base + noise(0.003), 0.001);
        ty[i] = i == 2 ? 0.0 : q(noise(0.003), 0.001);
      }
      feed(f, tx, ty, 3, 0.01);
    }
    CHECK(!f.sensor(2).healthy, "зависший при движении — исключён");
    Fusion g;
    g.setCount(3);
    for (int i = 0; i < 3; i++) g.setPresent(i, true);
    for (int k = 0; k < 400; k++) {
      double tx[3] = {0.1, 0.1, 0.1}, ty[3] = {0, 0, 0};
      feed(g, tx, ty, 3, 0.01);
    }
    CHECK(g.sensor(0).healthy && g.sensor(1).healthy && g.sensor(2).healthy, "все неподвижны без шума — не «зависание»");
  }

  // Два датчика расходятся — наклон недостоверен; один датчик — достоверен
  {
    Fusion f;
    f.setCount(2);
    for (int i = 0; i < 2; i++) f.setPresent(i, true);
    for (int k = 0; k < 200; k++) {
      double tx[2] = {0.0, 0.4}, ty[2] = {0, 0};
      feed(f, tx, ty, 2, 0.01);
    }
    CHECK(!f.fused().valid && f.fused().used == 2, "2 датчика расходятся → недостоверно");
    Fusion g;
    g.setCount(1);
    g.setPresent(0, true);
    for (int k = 0; k < 50; k++) {
      double tx[1] = {0.25}, ty[1] = {-0.1};
      feed(g, tx, ty, 1, 0.01);
    }
    CHECK(g.fused().valid && fabs(g.fused().x - 0.25) < 1e-3, "1 датчик → достоверно");
  }

  // Калибровка: zero → показания 0; отказ чтения → «нет связи»
  {
    Fusion f;
    f.setCount(3);
    for (int i = 0; i < 3; i++) f.setPresent(i, true);
    for (int k = 0; k < 300; k++) {
      double tx[3] = {0.21, 0.2, 0.19}, ty[3] = {-0.05, -0.04, -0.06};
      feed(f, tx, ty, 3, 0.01);
    }
    f.zeroAll();
    CHECK(fabs(f.sensor(0).x) < 1e-3 && fabs(f.sensor(2).y) < 1e-3, "zero обнуляет показания");
    f.setDt(0.01);
    for (int k = 0; k < 20; k++) f.update(1, false, 0, 0, 0);
    CHECK(!f.sensor(1).healthy && strstr(f.sensor(1).reason, "связи"), "ошибки чтения → «нет связи»");
  }

  // Команды
  {
    Command c = parseCommand("offsets 0.1 -0.2 0.3 0.4 0 0\n");
    CHECK(c.type == CMD_OFFSETS && c.nv == 6 && fabs(c.v[1] + 0.2) < 1e-12, "offsets");
    CHECK(parseCommand("tau 0.3").type == CMD_TAU, "tau");
    CHECK(parseCommand("rate").type == CMD_UNKNOWN, "rate без числа");
    CHECK(parseCommand("offsets 1 2").type == CMD_UNKNOWN, "offsets мало чисел");
    CHECK(parseCommand("hello").type == CMD_UNKNOWN, "неизвестная");
    CHECK(parseCommand("   ").type == CMD_NONE, "пустая");
    CHECK(parseCommand("sim 0.5 -0.2").type == CMD_SIM, "sim");
  }

  // Замкнутый контур: стол с наклоном, 3 сервы с рычагом, датчики с шумом → Fusion → Leveler
  {
    struct Run { double tiltAfter; int state; double t; };
    // stepDeg — дискретность сервы (STS3215 ≈ 0.088°, PWM-сервы с мёртвой зоной ≈ 0.3°)
    auto run = [](double tableX, double tableY, double stepDeg, double lever, double seconds, double kick) -> Run {
      const float pos[3][2] = {{-85, -85}, {85, -85}, {0, 85}};
      Fusion f;
      f.setCount(3);
      for (int i = 0; i < 3; i++) f.setPresent(i, true);
      FusionParams fp = defaultParams();
      fp.tau = 0.25f;
      f.setParams(fp);
      Leveler lv;
      lv.setGeometry(pos, 3);
      LevelerParams lp = defaultLevelerParams();
      lp.zMax = (float)(lever * sin(50 * D2R));
      lp.ki = (float)(0.5 / fp.tau > 1 ? 1 : 0.5 / fp.tau);
      lv.setParams(lp);
      lv.setAuto(true);
      double za[3] = {0, 0, 0};  // фактическое положение опор
      double tx = 0, ty = 0;
      const double dt = 0.01;
      for (int k = 0; k < (int)(seconds / dt); k++) {
        if (kick && k == (int)(seconds / dt / 2)) tableX += kick;  // возмущение на середине
        for (int i = 0; i < 3; i++) {
          // серва: угол квантуется дискретностью, отрабатывает с запаздыванием ~0.1 с
          const double ang = floor(leverAngle(lv.z(i), lever) / stepDeg + 0.5) * stepDeg;
          const double zt = lever * sin(ang * D2R);
          za[i] += (zt - za[i]) * dt / 0.1;
        }
        // плоскость через три опоры + наклон стола
        const double ux = pos[1][0] - pos[0][0], uy = pos[1][1] - pos[0][1], uz = za[1] - za[0];
        const double vx = pos[2][0] - pos[0][0], vy = pos[2][1] - pos[0][1], vz = za[2] - za[0];
        const double nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        tx = tableX + atan(-nx / nz) / D2R;
        ty = tableY + atan(-ny / nz) / D2R;
        double sx[3], sy[3];
        for (int i = 0; i < 3; i++) {
          sx[i] = q(tx + noise(0.004), 0.0055);
          sy[i] = q(ty + noise(0.004), 0.0055);
        }
        feed(f, sx, sy, 3, dt);
        lv.update(dt, f.fused().valid, f.fused().x, f.fused().y);
      }
      Run r;
      r.tiltAfter = fabs(tx) > fabs(ty) ? fabs(tx) : fabs(ty);
      r.state = lv.state();
      r.t = seconds;
      return r;
    };
    Run a = run(0.6, -0.4, 0.088, 15, 30, 0);
    CHECK(a.state == LV_LEVEL && a.tiltAfter < 0.03, "STS3215, рычаг 15 мм: выровнялась");
    fprintf(stderr, "  STS3215/15 мм: наклон после 30 с %.4f°, состояние %d\n", a.tiltAfter, a.state);
    Run b = run(0.6, -0.4, 0.088, 15, 60, 0.3);
    CHECK(b.state == LV_LEVEL && b.tiltAfter < 0.03, "возмущение 0.3° отработано");
    Run c = run(8.0, 0, 0.088, 15, 30, 0);
    CHECK(c.state == LV_LIMIT, "наклон стола 8° больше хода — состояние «не хватает хода»");
    Run d = run(0.6, -0.4, 0.3, 25, 30, 0);
    fprintf(stderr, "  PWM-серва 0.3°/25 мм: наклон %.4f°, состояние %d (точность ограничена мёртвой зоной)\n", d.tiltAfter, d.state);
    CHECK(d.tiltAfter < 0.1, "PWM-серва: хотя бы грубо выравнивает");
    Leveler m;
    m.setManual(1, 99);
    CHECK(!m.isAuto() && m.z(1) <= m.params().zMax, "ручная установка ограничена ходом");
    CHECK(fabs(leverAngle(15 * sin(30 * D2R), 15) - 30) < 1e-9, "угол рычага");
    Command cm = parseCommand("servo 2 1.5");
    CHECK(cm.type == CMD_SERVO && cm.nv == 2, "servo i z");
    CHECK(parseCommand("auto 1").type == CMD_AUTO && parseCommand("home").type == CMD_HOME, "auto / home");
  }

  // JSON состояния — печатаем, run.sh проверит его парсером
  {
    Fusion f;
    f.setCount(3);
    for (int i = 0; i < 3; i++) f.setPresent(i, true);
    double tx[3] = {0.1, 0.11, 0.09}, ty[3] = {0, 0, 0};
    feed(f, tx, ty, 3, 0.01);
    char buf[1024];
    Leveler lv;
    lv.setAuto(true);
    int n = formatState(buf, sizeof(buf), 123456, f, 99.5f, "SCL3300", &lv);
    CHECK(n > 50 && n < (int)sizeof(buf), "длина JSON");
    printf("%s\n", buf);
    char small[40];
    n = formatState(small, sizeof(small), 1, f, 1, "X");
    CHECK(n == (int)strlen(small) && n < 40, "обрезка по размеру буфера");
  }

  fprintf(stderr, "%d/%d проверок пройдено\n", total - fails, total);
  return fails ? 1 : 0;
}
