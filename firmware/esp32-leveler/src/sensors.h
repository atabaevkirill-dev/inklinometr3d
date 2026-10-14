// Драйверы инклинометров. Все отдают вектор ускорения в g (в осях датчика) и температуру.
#pragma once
#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <leveler_core.h>

class TiltSensor {
 public:
  virtual ~TiltSensor() {}
  virtual bool begin() = 0;
  virtual bool read(lev::Vec3& g, float& tempC) = 0;
  virtual const char* name() const = 0;
};

// Murata SCL3300: 3 оси, SPI режим 0, 32-битные кадры с CRC, ответ приходит в следующем кадре.
class SCL3300Sensor : public TiltSensor {
 public:
  SCL3300Sensor(SPIClass& spi, int cs) : spi_(spi), cs_(cs) {}
  bool begin() override;
  bool read(lev::Vec3& g, float& tempC) override;
  const char* name() const override { return "SCL3300"; }

 private:
  uint32_t xfer(uint32_t cmd);
  SPIClass& spi_;
  int cs_;
};

// Analog Devices ADXL355: 20 бит, ±2 g, SPI режим 0.
class ADXL355Sensor : public TiltSensor {
 public:
  ADXL355Sensor(SPIClass& spi, int cs) : spi_(spi), cs_(cs) {}
  bool begin() override;
  bool read(lev::Vec3& g, float& tempC) override;
  const char* name() const override { return "ADXL355"; }

 private:
  uint8_t readReg(uint8_t reg);
  void writeReg(uint8_t reg, uint8_t v);
  void readRegs(uint8_t reg, uint8_t* buf, size_t n);
  SPIClass& spi_;
  int cs_;
};

// MPU-6050 (GY-521): I2C, адрес 0x68 (AD0 на GND) или 0x69 (AD0 на 3.3 В).
class MPU6050Sensor : public TiltSensor {
 public:
  MPU6050Sensor(TwoWire& wire, uint8_t addr) : wire_(wire), addr_(addr) {}
  bool begin() override;
  bool read(lev::Vec3& g, float& tempC) override;
  const char* name() const override { return "MPU6050"; }

 private:
  bool writeReg(uint8_t reg, uint8_t v);
  bool readRegs(uint8_t reg, uint8_t* buf, size_t n);
  TwoWire& wire_;
  uint8_t addr_;
};

// Имитация без железа: наклон платформы задаётся командой "sim x y", плюс шум.
class SimSensor : public TiltSensor {
 public:
  explicit SimSensor(int index) : index_(index) {}
  bool begin() override { return true; }
  bool read(lev::Vec3& g, float& tempC) override;
  const char* name() const override { return "SIM"; }
  static void setTilt(float x, float y) {  // наклон «стола» под платформой
    tiltX_ = x;
    tiltY_ = y;
  }
  static void setServoTilt(float x, float y) {  // добавка от сервоприводов
    servoX_ = x;
    servoY_ = y;
  }

 private:
  int index_;
  static float tiltX_, tiltY_, servoX_, servoY_;
};
