// Сервоприводы с рычагом: подъём опоры z (мм) → угол рычага → сигнал серве.
#pragma once
#include <Arduino.h>

class Servos {
 public:
  void begin();
  void write(const float z[3]);  // мм от нейтрали для опор A, B, C
  const char* name() const;
};
