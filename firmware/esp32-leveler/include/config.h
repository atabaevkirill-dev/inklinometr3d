// Настройки прошивки тестовой платформы 200×200 мм.
// Тип датчика выбирается окружением PlatformIO (platformio.ini) через -DSENSOR_TYPE=...
#pragma once
#include <leveler_core.h>

// ---------- тип датчиков ----------
#define SENSOR_SCL3300 1  // Murata SCL3300 — инклинометр, SPI (рекомендую)
#define SENSOR_ADXL355 2  // Analog Devices ADXL355 — малошумящий акселерометр, SPI
#define SENSOR_MPU6050 3  // MPU-6050 (GY-521) — дешёвый, I2C, только для проверки связи и сайта
#define SENSOR_SIM 4      // без датчиков: имитация (наклон задаётся командой "sim x y")

#ifndef SENSOR_TYPE
#define SENSOR_TYPE SENSOR_SCL3300
#endif

// Сколько инклинометров подключено (1–3)
#ifndef SENSOR_COUNT
#define SENSOR_COUNT 3
#endif

// ---------- выводы ESP32 DevKit (WROOM-32) ----------
// SPI (VSPI): общий для всех датчиков, у каждого свой CS
#define PIN_SCK 18
#define PIN_MISO 19
#define PIN_MOSI 23
static const int PIN_CS[3] = {5, 4, 27};
// I2C для MPU-6050: первая шина — датчики с адресами 0x68 и 0x69, вторая — третий датчик 0x68
#define PIN_SDA0 21
#define PIN_SCL0 22
#define PIN_SDA1 25
#define PIN_SCL1 26
#define PIN_LED 2  // встроенный светодиод: мигает — идут измерения

// ---------- сервоприводы с рычагом под платформой (самовыравнивание) ----------
#define SERVO_NONE 0
#define SERVO_PWM 1  // обычные PWM-сервы (DS3218, MG996R…): сигнал 50 Гц, обратной связи нет
#define SERVO_STS 2  // шинные сервы Feetech STS3215: UART 1 Мбит/с, магнитный энкодер 4096 шагов/оборот (рекомендую)
#ifndef SERVO_TYPE
#define SERVO_TYPE SERVO_STS
#endif
// Точки крепления тяг к платформе, мм от центра: A, B, C (те же, что опоры на сайте)
static const float SERVO_POS[3][2] = {{-85, -85}, {85, -85}, {0, 85}};
#define LEVER_MM 15.0f       // рычаг: от оси сервы до шарнира тяги. Короче — точнее, но меньше ход
#define LEVER_MAX_DEG 50.0f  // предельный угол рычага от горизонтали
// PWM-сервы: сигнальные провода
static const int SERVO_PIN[3] = {32, 14, 13};
static const float SERVO_CENTER_US[3] = {1500, 1500, 1500};  // импульс, при котором рычаг горизонтален
#define SERVO_US_PER_DEG 11.11f                               // 2000 мкс на 180°; у 270-градусных серв 7.41
static const int SERVO_DIR[3] = {1, 1, 1};                    // −1, если рычаг идёт вниз при росте импульса
// Шинные сервы Feetech: одна линия данных через адаптер (или TX напрямую — только запись)
#define STS_TX_PIN 17
#define STS_RX_PIN 16
static const int STS_ID[3] = {1, 2, 3};
static const int STS_CENTER[3] = {2048, 2048, 2048};  // позиция «рычаг горизонтален»
static const int STS_DIR[3] = {1, 1, 1};

// ---------- геометрия тестовой платформы ----------
// Положение датчиков на плите, мм от центра (X — вправо, Y — назад). Нужно только сайту для схемы.
static const float SENSOR_POS[3][2] = {{-70, -70}, {70, -70}, {0, 70}};
// Как датчик повёрнут на плите. Проверка: приподнимите правый край — X должен расти,
// задний край — Y должен расти. Если нет — поменяйте rot / flip для этого датчика.
static const lev::Mount SENSOR_MOUNT[3] = {{0, false, false}, {0, false, false}, {0, false, false}};

// ---------- обработка ----------
#define SAMPLE_HZ 100       // опрос датчиков
#define OUTPUT_HZ 20        // отправка на сайт
#define FILTER_TAU 0.5f     // постоянная времени фильтра, с

// Пороги отказов зависят от класса датчика
#if SENSOR_TYPE == SENSOR_MPU6050
#define FAULT_DEG 0.3f
#define NOISE_FAULT_DEG 0.5f
#define RESOLUTION_DEG 0.005f
#elif SENSOR_TYPE == SENSOR_ADXL355
#define FAULT_DEG 0.05f
#define NOISE_FAULT_DEG 0.05f
#define RESOLUTION_DEG 0.0002f
#else
#define FAULT_DEG 0.1f
#define NOISE_FAULT_DEG 0.08f
#define RESOLUTION_DEG 0.0055f
#endif

// ---------- связь ----------
#ifndef SERIAL_BAUD
#define SERIAL_BAUD 230400
#endif
#define HOSTNAME "leveler"       // http://leveler.local, ws://leveler.local:81
#define WS_PORT 81
#define AP_SSID "Leveler"        // своя точка доступа, если к Wi-Fi подключиться не удалось
#define AP_PASS "leveler123"     // минимум 8 символов
#define WIFI_TIMEOUT_MS 10000

// Логин/пароль домашнего Wi-Fi — в include/secrets.h (не попадает в git), образец: secrets.example.h
#if __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#define WIFI_PASS ""
#endif
