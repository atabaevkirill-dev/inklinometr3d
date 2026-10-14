#!/bin/sh
# Проверка синтаксиса Arduino-части на компьютере с заглушками API (test/host/stubs).
# Полную сборку под ESP32 делает PlatformIO: pio run
set -e
cd "$(dirname "$0")/../.."
for t in 1 2 3 4; do
  for sv in 0 1 2; do
    c++ -std=gnu++11 -fsyntax-only -Wall -Wextra -Wno-unused-parameter -DSENSOR_TYPE=$t -DSERVO_TYPE=$sv \
      -I test/host/stubs -I include -I lib/leveler_core/src src/*.cpp lib/leveler_core/src/*.cpp
  done
  echo "SENSOR_TYPE=$t (сервы: нет/PWM/STS): синтаксис OK"
done
