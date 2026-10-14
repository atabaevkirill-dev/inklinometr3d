#!/bin/sh
# Сборка и запуск тестов ядра на компьютере (нужен c++ / clang++ / g++)
set -e
cd "$(dirname "$0")/../.."
mkdir -p .pio-host
c++ -std=c++14 -Wall -Wextra -O1 -I lib/leveler_core/src lib/leveler_core/src/leveler_core.cpp test/host/test_core.cpp -o .pio-host/test_core
./.pio-host/test_core > .pio-host/state.json
python3 -c "import json,sys; d=json.load(open('.pio-host/state.json')); assert d['f']['v']==1 and len(d['s'])==3 and d['m']['auto']==1; print('JSON OK:', list(d.keys()))"
