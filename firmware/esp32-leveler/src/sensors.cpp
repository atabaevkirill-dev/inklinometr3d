#include "sensors.h"

#include <math.h>

using namespace lev;

// ================= SCL3300 =================
static const SPISettings SCL_SPI(2000000, MSBFIRST, SPI_MODE0);

uint32_t SCL3300Sensor::xfer(uint32_t cmd) {
  spi_.beginTransaction(SCL_SPI);
  digitalWrite(cs_, LOW);
  uint32_t r = spi_.transfer32(cmd);
  digitalWrite(cs_, HIGH);
  spi_.endTransaction();
  delayMicroseconds(12);  // между кадрами нужно ≥ 10 мкс
  return r;
}

bool SCL3300Sensor::begin() {
  pinMode(cs_, OUTPUT);
  digitalWrite(cs_, HIGH);
  delay(5);
  xfer(scl3300::SW_RESET);
  delay(5);
  xfer(scl3300::MODE_4);         // режим инклинометра с малым шумом
  xfer(scl3300::ENABLE_ANGLES);
  delay(120);                    // в режиме 4 сигнал устанавливается ~100 мс
  // статус читаем трижды — сбрасывает флаги старта
  xfer(scl3300::READ_STATUS);
  xfer(scl3300::READ_STATUS);
  xfer(scl3300::READ_STATUS);
  xfer(scl3300::READ_WHOAMI);
  uint32_t r = xfer(scl3300::READ_STATUS);  // ответ на WHOAMI приходит этим кадром
  int rs;
  int16_t data;
  return scl3300::decode(r, rs, data) && (data & 0xFF) == scl3300::WHOAMI_VALUE;
}

bool SCL3300Sensor::read(Vec3& g, float& tempC) {
  xfer(scl3300::READ_ACC_X);
  const uint32_t rx = xfer(scl3300::READ_ACC_Y);
  const uint32_t ry = xfer(scl3300::READ_ACC_Z);
  const uint32_t rz = xfer(scl3300::READ_TEMP);
  const uint32_t rt = xfer(scl3300::READ_STATUS);
  int sx, sy, sz, st;
  int16_t dx, dy, dz, dt;
  if (!scl3300::decode(rx, sx, dx) || !scl3300::decode(ry, sy, dy) || !scl3300::decode(rz, sz, dz) || !scl3300::decode(rt, st, dt)) return false;
  if (sx != 1 || sy != 1 || sz != 1) return false;  // 1 — нормальная работа
  g.x = dx / scl3300::LSB_PER_G_MODE4;
  g.y = dy / scl3300::LSB_PER_G_MODE4;
  g.z = dz / scl3300::LSB_PER_G_MODE4;
  tempC = scl3300::tempC(dt);
  return true;
}

// ================= ADXL355 =================
static const SPISettings ADX_SPI(4000000, MSBFIRST, SPI_MODE0);
static const uint8_t ADX_DEVID_AD = 0x00, ADX_DEVID_MST = 0x01, ADX_PARTID = 0x02, ADX_TEMP2 = 0x06, ADX_FILTER = 0x28,
                     ADX_RANGE = 0x2C, ADX_POWER_CTL = 0x2D, ADX_RESET = 0x2F;

uint8_t ADXL355Sensor::readReg(uint8_t reg) {
  uint8_t v;
  readRegs(reg, &v, 1);
  return v;
}

void ADXL355Sensor::writeReg(uint8_t reg, uint8_t v) {
  spi_.beginTransaction(ADX_SPI);
  digitalWrite(cs_, LOW);
  spi_.transfer((uint8_t)(reg << 1));
  spi_.transfer(v);
  digitalWrite(cs_, HIGH);
  spi_.endTransaction();
}

void ADXL355Sensor::readRegs(uint8_t reg, uint8_t* buf, size_t n) {
  spi_.beginTransaction(ADX_SPI);
  digitalWrite(cs_, LOW);
  spi_.transfer((uint8_t)((reg << 1) | 1));
  for (size_t i = 0; i < n; i++) buf[i] = spi_.transfer(0);
  digitalWrite(cs_, HIGH);
  spi_.endTransaction();
}

bool ADXL355Sensor::begin() {
  pinMode(cs_, OUTPUT);
  digitalWrite(cs_, HIGH);
  delay(5);
  writeReg(ADX_RESET, 0x52);
  delay(20);
  if (readReg(ADX_DEVID_AD) != 0xAD || readReg(ADX_DEVID_MST) != 0x1D || readReg(ADX_PARTID) != 0xED) return false;
  writeReg(ADX_FILTER, 0x06);     // ODR 62.5 Гц, ФНЧ 15.6 Гц
  writeReg(ADX_RANGE, 0x81);      // ±2 g
  writeReg(ADX_POWER_CTL, 0x00);  // измерение, температура включена
  delay(100);
  return true;
}

static int32_t adx20(const uint8_t* b) {
  int32_t v = ((int32_t)b[0] << 12) | ((int32_t)b[1] << 4) | (b[2] >> 4);
  if (v & 0x80000) v -= 0x100000;
  return v;
}

bool ADXL355Sensor::read(Vec3& g, float& tempC) {
  uint8_t b[11];  // TEMP2, TEMP1, XDATA3..ZDATA1
  readRegs(ADX_TEMP2, b, sizeof(b));
  const int32_t x = adx20(b + 2), y = adx20(b + 5), z = adx20(b + 8);
  if (x == 0 && y == 0 && z == 0) return false;  // нет ответа
  const float lsb = 256000.0f;                    // ±2 g: 3.9 мкg на единицу
  g.x = x / lsb;
  g.y = y / lsb;
  g.z = z / lsb;
  const int traw = ((b[0] & 0x0F) << 8) | b[1];
  tempC = 25.0f + (traw - 1885) / -9.05f;
  return true;
}

// ================= MPU-6050 =================
bool MPU6050Sensor::writeReg(uint8_t reg, uint8_t v) {
  wire_.beginTransmission(addr_);
  wire_.write(reg);
  wire_.write(v);
  return wire_.endTransmission() == 0;
}

bool MPU6050Sensor::readRegs(uint8_t reg, uint8_t* buf, size_t n) {
  wire_.beginTransmission(addr_);
  wire_.write(reg);
  if (wire_.endTransmission(false) != 0) return false;
  if (wire_.requestFrom((int)addr_, (int)n) != (int)n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = wire_.read();
  return true;
}

bool MPU6050Sensor::begin() {
  uint8_t who = 0;
  if (!readRegs(0x75, &who, 1) || who != 0x68) return false;  // WHO_AM_I
  writeReg(0x6B, 0x01);  // проснуться, тактирование от гироскопа
  writeReg(0x1A, 0x05);  // цифровой ФНЧ ~10 Гц
  writeReg(0x1C, 0x00);  // ±2 g
  delay(50);
  return true;
}

bool MPU6050Sensor::read(Vec3& g, float& tempC) {
  uint8_t b[8];
  if (!readRegs(0x3B, b, sizeof(b))) return false;
  const int16_t ax = (int16_t)((b[0] << 8) | b[1]), ay = (int16_t)((b[2] << 8) | b[3]), az = (int16_t)((b[4] << 8) | b[5]);
  const int16_t t = (int16_t)((b[6] << 8) | b[7]);
  g.x = ax / 16384.0f;
  g.y = ay / 16384.0f;
  g.z = az / 16384.0f;
  tempC = t / 340.0f + 36.53f;
  return true;
}

// ================= имитация =================
float SimSensor::tiltX_ = 0.35f;
float SimSensor::tiltY_ = -0.2f;
float SimSensor::servoX_ = 0;
float SimSensor::servoY_ = 0;

static float gaussNoise(float sigma) {
  float s = 0;
  for (int k = 0; k < 6; k++) s += (float)random(0, 10000) / 10000.0f;
  return (s - 3.0f) * sigma * 1.414f;
}

bool SimSensor::read(Vec3& g, float& tempC) {
  const float d2r = 0.01745329f;
  // у каждого «датчика» своё небольшое смещение нуля
  const float bx = 0.004f * (index_ - 1), by = -0.003f * (index_ - 1);
  g.x = sinf((tiltX_ + servoX_ + bx + gaussNoise(0.004f)) * d2r);
  g.y = sinf((tiltY_ + servoY_ + by + gaussNoise(0.004f)) * d2r);
  g.z = sqrtf(1.0f - g.x * g.x - g.y * g.y);
  tempC = 24.0f + 0.5f * index_;
  return true;
}
