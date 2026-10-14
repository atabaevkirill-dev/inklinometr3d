#include "comms.h"

#include <ESPmDNS.h>
#include <WebServer.h>
#include <WebSocketsServer.h>
#include <WiFi.h>

#include "config.h"

Comms comms;

static WebServer http(80);
static WebSocketsServer ws(WS_PORT);
static String lastState = "{}";
static volatile bool newClient = false;

static void onWsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  (void)num;
  if (type == WStype_CONNECTED) {
    newClient = true;
  } else if (type == WStype_TEXT) {
    String s;
    s.reserve(length);
    for (size_t i = 0; i < length; i++) s += (char)payload[i];
    s.trim();
    if (s.length()) comms.queueCommand(s);
  }
}

static const char PAGE[] PROGMEM = R"HTML(<!doctype html><html lang="ru"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Leveler</title>
<body style="font:14px system-ui;background:#0b0f14;color:#e6edf3;padding:16px">
<h2>Тестовая платформа — ESP32</h2>
<p>Данные идут по WebSocket: <code id="ws"></code>. Откройте страницу <b>live.html</b> проекта и выберите «Wi-Fi».</p>
<pre id="s" style="white-space:pre-wrap;background:#111821;padding:8px;border-radius:6px"></pre>
<script>
const u='ws://'+location.hostname+':81';document.getElementById('ws').textContent=u;
const w=new WebSocket(u);w.onmessage=e=>{if(e.data[0]=='{'&&e.data.includes('"f"'))document.getElementById('s').textContent=e.data};
</script></body></html>)HTML";

void Comms::begin() {
  WiFi.setHostname(HOSTNAME);
  bool ok = false;
  if (strlen(WIFI_SSID)) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    const uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TIMEOUT_MS) delay(200);
    ok = WiFi.status() == WL_CONNECTED;
  }
  if (!ok) {
    // своя точка доступа: подключиться к "Leveler", адрес 192.168.4.1
    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    ap_ = true;
  }
  WiFi.setSleep(false);  // меньше задержка WebSocket
  if (MDNS.begin(HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    MDNS.addService("ws", "tcp", WS_PORT);
  }
  http.on("/", []() { http.send_P(200, "text/html; charset=utf-8", PAGE); });
  http.on("/state", []() {
    http.sendHeader("Access-Control-Allow-Origin", "*");
    http.send(200, "application/json", lastState);
  });
  http.begin();
  ws.begin();
  ws.onEvent(onWsEvent);
}

void Comms::loop() {
  http.handleClient();
  ws.loop();
  while (Serial.available()) {
    const char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      serialBuf_.trim();
      if (serialBuf_.length()) queueCommand(serialBuf_);
      serialBuf_ = "";
    } else if (serialBuf_.length() < 200) {
      serialBuf_ += ch;
    }
  }
}

void Comms::send(const char* line) {
  Serial.println(line);
  ws.broadcastTXT(line);
  if (line[0] == '{' && strstr(line, "\"f\":")) lastState = line;
}

void Comms::queueCommand(const String& c) {
  if (qLen_ >= 8) return;  // очередь полна — команду теряем
  queue_[(qHead_ + qLen_) % 8] = c;
  qLen_++;
}

bool Comms::popCommand(String& out) {
  if (!qLen_) return false;
  out = queue_[qHead_];
  qHead_ = (qHead_ + 1) % 8;
  qLen_--;
  return true;
}

bool Comms::takeNewClient() {
  if (!newClient) return false;
  newClient = false;
  return true;
}

String Comms::address() const { return ap_ ? WiFi.softAPIP().toString() : WiFi.localIP().toString(); }
