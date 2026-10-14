#pragma once
#include "Arduino.h"
typedef enum { WStype_ERROR, WStype_DISCONNECTED, WStype_CONNECTED, WStype_TEXT, WStype_BIN } WStype_t;
class WebSocketsServer {
 public:
  typedef void (*WebSocketServerEvent)(uint8_t num, WStype_t type, uint8_t* payload, size_t length);
  explicit WebSocketsServer(uint16_t port);
  void begin();
  void loop();
  void onEvent(WebSocketServerEvent cb);
  bool broadcastTXT(const char* payload, size_t length = 0);
};
