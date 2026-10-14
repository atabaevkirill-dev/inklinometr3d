#pragma once
#include "Arduino.h"
class IPAddress { public: String toString() const; };
enum wl_status_t { WL_IDLE_STATUS, WL_CONNECTED };
enum wifi_mode_t { WIFI_OFF, WIFI_STA, WIFI_AP };
class WiFiClass {
 public:
  bool setHostname(const char*);
  bool mode(wifi_mode_t);
  wl_status_t begin(const char*, const char*);
  wl_status_t status();
  bool softAP(const char*, const char*);
  IPAddress softAPIP();
  IPAddress localIP();
  void setSleep(bool);
};
extern WiFiClass WiFi;
