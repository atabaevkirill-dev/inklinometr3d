#pragma once
class MDNSResponder { public: bool begin(const char*); void addService(const char*, const char*, uint16_t); };
extern MDNSResponder MDNS;
