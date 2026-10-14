// Заглушки Arduino API только для проверки синтаксиса на компьютере (test/host/check_syntax.sh).
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <functional>
#include <string>
#define PROGMEM
#define OUTPUT 1
#define INPUT 0
#define HIGH 1
#define LOW 0
#define constrain(a, lo, hi) ((a) < (lo) ? (lo) : ((a) > (hi) ? (hi) : (a)))
void pinMode(int, int);
void digitalWrite(int, int);
int digitalRead(int);
void delay(uint32_t);
void delayMicroseconds(uint32_t);
uint32_t millis();
uint32_t micros();
long random(long, long);
class String {
 public:
  String() {}
  String(const char* s) : s_(s) {}
  String& operator+=(char c) { s_ += c; return *this; }
  String& operator=(const char* s) { s_ = s; return *this; }
  void reserve(size_t n) { s_.reserve(n); }
  void trim() {}
  unsigned length() const { return (unsigned)s_.size(); }
  const char* c_str() const { return s_.c_str(); }
 private:
  std::string s_;
};
class HardwareSerial {
 public:
  void begin(unsigned long baud, uint32_t config = 0x800001c, int8_t rx = -1, int8_t tx = -1);
  size_t println(const char*);
  size_t write(const uint8_t*, size_t);
  int available();
  int read();
};
extern HardwareSerial Serial, Serial2;
bool ledcSetup(uint8_t ch, double freq, uint8_t bits);
void ledcAttachPin(uint8_t pin, uint8_t ch);
void ledcWrite(uint8_t ch, uint32_t duty);
#define SERIAL_8N1 0x800001c
