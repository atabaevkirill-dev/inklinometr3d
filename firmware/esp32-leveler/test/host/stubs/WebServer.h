#pragma once
#include "Arduino.h"
class WebServer {
 public:
  explicit WebServer(int port);
  void on(const char* uri, std::function<void()> handler);
  void send(int code, const char* type, const String& content);
  void send_P(int code, const char* type, const char* content);
  void sendHeader(const char* name, const char* value);
  void begin();
  void handleClient();
};
