// Связь с сайтом: USB (Serial, для Web Serial) и Wi-Fi (WebSocket :81, HTTP :80).
// Одни и те же JSON-строки уходят во все каналы; команды — текстом по строке из любого канала.
#pragma once
#include <Arduino.h>

class Comms {
 public:
  void begin();
  void loop();
  void send(const char* line);
  bool popCommand(String& out);
  void queueCommand(const String& c);
  bool takeNewClient();  // true один раз после подключения нового клиента (отправить info)
  String address() const;
  bool apMode() const { return ap_; }

 private:
  String queue_[8];
  int qHead_ = 0, qLen_ = 0;
  String serialBuf_;
  bool ap_ = false;
};

extern Comms comms;
