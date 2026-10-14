#pragma once
#include "Arduino.h"
#define MSBFIRST 1
#define SPI_MODE0 0
class SPISettings { public: SPISettings(uint32_t, uint8_t, uint8_t) {} };
class SPIClass {
 public:
  void begin(int8_t sck, int8_t miso, int8_t mosi, int8_t ss = -1);
  void beginTransaction(SPISettings);
  void endTransaction();
  uint8_t transfer(uint8_t);
  uint32_t transfer32(uint32_t);
};
extern SPIClass SPI;
