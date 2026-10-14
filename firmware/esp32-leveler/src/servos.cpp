#include "servos.h"

#include <leveler_core.h>

#include "config.h"

#if SERVO_TYPE == SERVO_PWM
// ---------- обычные сервы: ШИМ 50 Гц, 16 бит (шаг ≈ 0.3 мкс) ----------
static const int PWM_BITS = 16;
static void pwmAttach(int ch, int pin) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)ch;
  ledcAttach(pin, 50, PWM_BITS);
#else
  ledcSetup(ch, 50, PWM_BITS);
  ledcAttachPin(pin, ch);
#endif
}
static void pwmWriteUs(int ch, int pin, float us) {
  const uint32_t duty = (uint32_t)(us / 20000.0f * ((1 << PWM_BITS) - 1));
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  (void)ch;
  ledcWrite(pin, duty);
#else
  (void)pin;
  ledcWrite(ch, duty);
#endif
}
void Servos::begin() {
  for (int i = 0; i < 3; i++) pwmAttach(i, SERVO_PIN[i]);
}
void Servos::write(const float z[3]) {
  for (int i = 0; i < 3; i++) {
    const float deg = (float)lev::leverAngle(z[i], LEVER_MM);
    const float us = constrain(SERVO_CENTER_US[i] + SERVO_DIR[i] * deg * SERVO_US_PER_DEG, 500.0f, 2500.0f);
    pwmWriteUs(i, SERVO_PIN[i], us);
  }
}
const char* Servos::name() const { return "PWM"; }

#elif SERVO_TYPE == SERVO_STS
// ---------- шинные сервы Feetech STS: пакет FF FF ID LEN INSTR ADDR DATA… CHK ----------
static HardwareSerial& bus = Serial2;
static void stsWrite(uint8_t id, uint8_t addr, const uint8_t* data, uint8_t n) {
  uint8_t pkt[24];
  pkt[0] = 0xFF;
  pkt[1] = 0xFF;
  pkt[2] = id;
  pkt[3] = (uint8_t)(n + 3);  // адрес + данные + инструкция + контрольная сумма
  pkt[4] = 0x03;              // WRITE
  pkt[5] = addr;
  uint8_t sum = (uint8_t)(id + pkt[3] + pkt[4] + addr);
  for (uint8_t i = 0; i < n; i++) {
    pkt[6 + i] = data[i];
    sum = (uint8_t)(sum + data[i]);
  }
  pkt[6 + n] = (uint8_t)~sum;
  bus.write(pkt, 7 + n);
}
void Servos::begin() {
  bus.begin(1000000, SERIAL_8N1, STS_RX_PIN, STS_TX_PIN);
  delay(50);
  const uint8_t on = 1;
  for (int i = 0; i < 3; i++) stsWrite((uint8_t)STS_ID[i], 40, &on, 1);  // включить момент
}
void Servos::write(const float z[3]) {
  for (int i = 0; i < 3; i++) {
    const double deg = lev::leverAngle(z[i], LEVER_MM);
    int pos = STS_CENTER[i] + (int)lround(STS_DIR[i] * deg * 4096.0 / 360.0);
    pos = constrain(pos, 0, 4095);
    const uint16_t speed = 1500;  // шагов/с
    // с адреса 41: ускорение, позиция (2 байта, младший первым), время (2), скорость (2)
    const uint8_t d[7] = {50, (uint8_t)(pos & 0xFF), (uint8_t)(pos >> 8), 0, 0, (uint8_t)(speed & 0xFF), (uint8_t)(speed >> 8)};
    stsWrite((uint8_t)STS_ID[i], 41, d, 7);
  }
}
const char* Servos::name() const { return "STS3215"; }

#else
void Servos::begin() {}
void Servos::write(const float z[3]) { (void)z; }
const char* Servos::name() const { return "нет"; }
#endif
