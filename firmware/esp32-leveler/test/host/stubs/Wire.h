#pragma once
#include "Arduino.h"
class TwoWire {
 public:
  bool begin(int sda, int scl, uint32_t freq);
  void beginTransmission(uint8_t);
  size_t write(uint8_t);
  uint8_t endTransmission(bool stop = true);
  uint8_t requestFrom(int addr, int n);
  int read();
};
extern TwoWire Wire, Wire1;
