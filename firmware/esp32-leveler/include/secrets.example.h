// Скопируйте этот файл в secrets.h и впишите свой Wi-Fi.
// secrets.h в .gitignore — пароль не попадёт в репозиторий.
// Без secrets.h ESP32 поднимет свою точку доступа "Leveler" (пароль leveler123), адрес 192.168.4.1.
#pragma once
#define WIFI_SSID "имя_сети"
#define WIFI_PASS "пароль"
