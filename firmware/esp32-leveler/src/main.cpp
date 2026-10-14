// Тестовая платформа 200×200 мм: 3 инклинометра → ESP32 → сайт (live.html) по USB или Wi-Fi.
// Пока без моторов: платформу выравнивают вручную, сайт показывает наклон и подсказывает,
// какую опору на сколько подкрутить.
#include <Arduino.h>
#include <Preferences.h>

#include "comms.h"
#include "config.h"
#include "sensors.h"
#include "servos.h"

using namespace lev;

static const char* FW_VERSION = "0.1.0";

static TiltSensor* sensors[MAX_SENSORS] = {nullptr, nullptr, nullptr};
static Fusion fusion;
static Leveler leveler;
static Servos servos;
static const bool HAS_SERVOS = SERVO_TYPE != SERVO_NONE || SENSOR_TYPE == SENSOR_SIM;
static Preferences prefs;
static float outputHz = OUTPUT_HZ;
static uint32_t lastSampleUs = 0, lastOutMs = 0, rateT0 = 0, sampleCount = 0;
static float sampleHz = 0;
static char buf[1400];

static const char* typeName() {
#if SENSOR_TYPE == SENSOR_SCL3300
  return "SCL3300";
#elif SENSOR_TYPE == SENSOR_ADXL355
  return "ADXL355";
#elif SENSOR_TYPE == SENSOR_MPU6050
  return "MPU6050";
#else
  return "SIM";
#endif
}

static void createSensors() {
#if SENSOR_TYPE == SENSOR_SCL3300 || SENSOR_TYPE == SENSOR_ADXL355
  // все CS — в высокий уровень до первой посылки, иначе датчики мешают друг другу на шине
  for (int i = 0; i < MAX_SENSORS; i++) {
    pinMode(PIN_CS[i], OUTPUT);
    digitalWrite(PIN_CS[i], HIGH);
  }
  SPI.begin(PIN_SCK, PIN_MISO, PIN_MOSI);
  for (int i = 0; i < SENSOR_COUNT; i++) {
#if SENSOR_TYPE == SENSOR_SCL3300
    sensors[i] = new SCL3300Sensor(SPI, PIN_CS[i]);
#else
    sensors[i] = new ADXL355Sensor(SPI, PIN_CS[i]);
#endif
  }
#elif SENSOR_TYPE == SENSOR_MPU6050
  Wire.begin(PIN_SDA0, PIN_SCL0, 400000);
  Wire1.begin(PIN_SDA1, PIN_SCL1, 400000);
  if (SENSOR_COUNT > 0) sensors[0] = new MPU6050Sensor(Wire, 0x68);
  if (SENSOR_COUNT > 1) sensors[1] = new MPU6050Sensor(Wire, 0x69);
  if (SENSOR_COUNT > 2) sensors[2] = new MPU6050Sensor(Wire1, 0x68);
#else
  for (int i = 0; i < SENSOR_COUNT; i++) sensors[i] = new SimSensor(i);
#endif
}

static void startSensors() {
  for (int i = 0; i < SENSOR_COUNT; i++) {
    const bool ok = sensors[i] && sensors[i]->begin();
    fusion.setPresent(i, ok);
    snprintf(buf, sizeof(buf), "{\"log\":\"датчик %d (%s): %s\"}", i + 1, typeName(), ok ? "найден" : "НЕ ОТВЕЧАЕТ — проверьте провода");
    comms.send(buf);
  }
}

// усиление выравнивания ограничено запаздыванием фильтра датчиков
static void syncLevelerGain() {
  LevelerParams lp = leveler.params();
  const float tau = fusion.params().tau;
  lp.ki = 0.5f / tau > 1.0f ? 1.0f : 0.5f / tau;
  leveler.setParams(lp);
}

// ---------- калибровка в энергонезависимой памяти ----------
static void saveSettings() {
  double off[2 * MAX_SENSORS];
  for (int i = 0; i < MAX_SENSORS; i++) {
    off[2 * i] = fusion.sensor(i).offX;
    off[2 * i + 1] = fusion.sensor(i).offY;
  }
  prefs.putBytes("off", off, sizeof(off));
  prefs.putFloat("tau", fusion.params().tau);
}

static void loadSettings() {
  double off[2 * MAX_SENSORS] = {0};
  if (prefs.getBytes("off", off, sizeof(off)) == sizeof(off)) {
    for (int i = 0; i < MAX_SENSORS; i++) fusion.setOffsets(i, off[2 * i], off[2 * i + 1]);
  }
  FusionParams p = fusion.params();
  p.tau = prefs.getFloat("tau", FILTER_TAU);
  fusion.setParams(p);
  syncLevelerGain();
}

static void sendInfo() {
  int n = snprintf(buf, sizeof(buf),
                   "{\"info\":{\"fw\":\"%s\",\"board\":\"ESP32\",\"type\":\"%s\",\"n\":%d,\"tau\":%.3f,\"rate\":%.1f,\"addr\":\"%s\",\"ap\":%d,\"host\":\"%s\",\"ws\":%d,\"pos\":[",
                   FW_VERSION, typeName(), SENSOR_COUNT, fusion.params().tau, outputHz, comms.address().c_str(), comms.apMode() ? 1 : 0, HOSTNAME, WS_PORT);
  for (int i = 0; i < SENSOR_COUNT; i++) n += snprintf(buf + n, sizeof(buf) - n, "%s[%.0f,%.0f]", i ? "," : "", SENSOR_POS[i][0], SENSOR_POS[i][1]);
  n += snprintf(buf + n, sizeof(buf) - n, "],\"off\":[");
  for (int i = 0; i < SENSOR_COUNT; i++) n += snprintf(buf + n, sizeof(buf) - n, "%s[%.5f,%.5f]", i ? "," : "", fusion.sensor(i).offX, fusion.sensor(i).offY);
  n += snprintf(buf + n, sizeof(buf) - n, "]");
  if (HAS_SERVOS) {
    n += snprintf(buf + n, sizeof(buf) - n, ",\"servo\":{\"type\":\"%s\",\"lever\":%.1f,\"zmax\":%.2f,\"pos\":[", SENSOR_TYPE == SENSOR_SIM && SERVO_TYPE == SERVO_NONE ? "SIM" : servos.name(),
                  LEVER_MM, leveler.params().zMax);
    for (int i = 0; i < 3; i++) n += snprintf(buf + n, sizeof(buf) - n, "%s[%.0f,%.0f]", i ? "," : "", SERVO_POS[i][0], SERVO_POS[i][1]);
    n += snprintf(buf + n, sizeof(buf) - n, "]}");
  }
  snprintf(buf + n, sizeof(buf) - n, "}}");
  comms.send(buf);
}

static void ack(const char* what) {
  snprintf(buf, sizeof(buf), "{\"ack\":\"%s\"}", what);
  comms.send(buf);
}

static void handleCommand(const String& line) {
  const Command c = parseCommand(line.c_str());
  switch (c.type) {
    case CMD_INFO:
      sendInfo();
      break;
    case CMD_ZERO:
      fusion.zeroAll();
      saveSettings();
      ack("zero");
      sendInfo();
      break;
    case CMD_CLEAR:
      fusion.clearOffsets();
      saveSettings();
      ack("clear");
      sendInfo();
      break;
    case CMD_OFFSETS:
      for (int i = 0; i < MAX_SENSORS; i++) fusion.setOffsets(i, c.v[2 * i], c.v[2 * i + 1]);
      saveSettings();
      ack("offsets");
      sendInfo();
      break;
    case CMD_TAU: {
      FusionParams p = fusion.params();
      p.tau = constrain((float)c.v[0], 0.05f, 5.0f);
      fusion.setParams(p);
      syncLevelerGain();
      saveSettings();
      ack("tau");
      break;
    }
    case CMD_RATE:
      outputHz = constrain((float)c.v[0], 1.0f, 50.0f);
      ack("rate");
      break;
    case CMD_RESET:
      startSensors();  // повторно опросить датчики, которые не отвечали
      fusion.resetHealth();
      ack("reset");
      break;
    case CMD_SIM:
      SimSensor::setTilt((float)c.v[0], (float)c.v[1]);
      ack("sim");
      break;
    case CMD_AUTO:
      leveler.setAuto(c.v[0] != 0);
      ack(c.v[0] != 0 ? "auto on" : "auto off");
      break;
    case CMD_HOME:
      leveler.home();
      ack("home");
      break;
    case CMD_HEIGHT:
      leveler.setHeight((float)c.v[0]);
      ack("height");
      break;
    case CMD_SERVO:
      leveler.setManual((int)c.v[0], (float)c.v[1]);
      ack("servo");
      break;
    case CMD_KI: {
      LevelerParams lp = leveler.params();
      lp.ki = constrain((float)c.v[0], 0.05f, 5.0f);
      leveler.setParams(lp);
      ack("ki");
      break;
    }
    case CMD_TOL: {
      LevelerParams lp = leveler.params();
      lp.tol = constrain((float)c.v[0], 0.001f, 1.0f);
      lp.restart = lp.tol * 2.5f > 0.05f ? lp.tol * 2.5f : 0.05f;
      leveler.setParams(lp);
      ack("tol");
      break;
    }
    case CMD_UNKNOWN:
      comms.send("{\"err\":\"неизвестная команда: info | zero | clear | offsets x1 y1 x2 y2 x3 y3 | tau с | rate Гц | reset | sim x y | auto 0/1 | home | height мм | servo i мм | ki | tol °\"}");
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(SERIAL_BAUD);
  pinMode(PIN_LED, OUTPUT);
  delay(200);
  prefs.begin("leveler", false);
  FusionParams p = defaultParams();
  p.faultDeg = FAULT_DEG;
  p.noiseFaultDeg = NOISE_FAULT_DEG;
  p.resolution = RESOLUTION_DEG;
  fusion.setParams(p);
  fusion.setCount(SENSOR_COUNT);
  leveler.setGeometry(SERVO_POS, 3);
  LevelerParams lp = defaultLevelerParams();
  lp.zMax = LEVER_MM * sinf(LEVER_MAX_DEG * 0.0174533f);
  leveler.setParams(lp);
  loadSettings();
  servos.begin();
  comms.begin();
  createSensors();
  startSensors();
  sendInfo();
  lastSampleUs = micros();
  rateT0 = millis();
}

void loop() {
  comms.loop();
  String line;
  while (comms.popCommand(line)) handleCommand(line);
  if (comms.takeNewClient()) sendInfo();

  const uint32_t now = micros();
  if (now - lastSampleUs >= 1000000UL / SAMPLE_HZ) {
    const double dt = (now - lastSampleUs) / 1e6;
    fusion.setDt(dt);
    lastSampleUs = now;
    for (int i = 0; i < SENSOR_COUNT; i++) {
      if (!fusion.sensor(i).present) continue;
      Vec3 g;
      float t = 0;
      const bool ok = sensors[i]->read(g, t);
      double tx = 0, ty = 0;
      if (ok) tiltFromAccel(applyMount(g, SENSOR_MOUNT[i]), tx, ty);
      fusion.update(i, ok, tx, ty, t);
    }
    fusion.fuse();
    if (HAS_SERVOS) {
      const Fused& fu = fusion.fused();
      leveler.update(dt, fu.valid, fu.x, fu.y);
      const float z[3] = {leveler.z(0), leveler.z(1), leveler.z(2)};
      servos.write(z);
#if SENSOR_TYPE == SENSOR_SIM
      // имитация: наклон платформы зависит от того, куда сервы подняли опоры
      double sx, sy;
      planeTilt(SERVO_POS, z, sx, sy);
      SimSensor::setServoTilt((float)sx, (float)sy);
#endif
    }
    sampleCount++;
  }

  const uint32_t ms = millis();
  if (ms - rateT0 >= 1000) {
    sampleHz = sampleCount * 1000.0f / (ms - rateT0);
    sampleCount = 0;
    rateT0 = ms;
  }
  if (ms - lastOutMs >= (uint32_t)(1000.0f / outputHz)) {
    lastOutMs = ms;
    formatState(buf, sizeof(buf), ms, fusion, sampleHz, typeName(), HAS_SERVOS ? &leveler : NULL);
    comms.send(buf);
    digitalWrite(PIN_LED, !digitalRead(PIN_LED));
  }
}
