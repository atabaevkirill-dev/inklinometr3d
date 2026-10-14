#pragma once
#include "Arduino.h"
class Preferences {
 public:
  bool begin(const char*, bool readOnly = false);
  size_t putBytes(const char*, const void*, size_t);
  size_t getBytes(const char*, void*, size_t);
  size_t putFloat(const char*, float);
  float getFloat(const char*, float def = 0);
};
