// Ядро прошивки: чистый C++11 без Arduino — собирается и тестируется на компьютере (test/host).
// Наклон из ускорений, ориентация датчика, фильтр, слияние 2 из 3 с обнаружением отказов,
// CRC кадров SCL3300, разбор текстовых команд.
#pragma once
#include <stdint.h>
#include <stddef.h>

namespace lev {

// Число датчиков на плате (под 3 инклинометра)
static const int MAX_SENSORS = 3;

struct Vec3 {
  float x, y, z;
};

// Как датчик повёрнут относительно платформы (вокруг вертикали, против часовой) и отражения осей.
// Платформа: X — вправо, Y — назад (от оператора), Z — вверх.
struct Mount {
  int rot;     // 0, 90, 180, 270
  bool flipX;  // поменять знак X после поворота
  bool flipY;  // поменять знак Y после поворота
};

Vec3 applyMount(const Vec3& s, const Mount& m);

// Наклон по вектору ускорения (датчик в покое меряет +1 g вверх).
// tiltX > 0 — правый край (+X) выше, tiltY > 0 — задний край (+Y) выше. Градусы.
void tiltFromAccel(const Vec3& a, double& tiltX, double& tiltY);

// ---------- SCL3300 (Murata): 32-битные кадры SPI с CRC8 ----------
namespace scl3300 {
static const uint32_t READ_ACC_X = 0x040000F7;
static const uint32_t READ_ACC_Y = 0x080000FD;
static const uint32_t READ_ACC_Z = 0x0C0000FB;
static const uint32_t READ_TEMP = 0x140000EF;
static const uint32_t READ_STATUS = 0x180000E5;
static const uint32_t READ_WHOAMI = 0x40000091;
static const uint32_t MODE_4 = 0xB4000338;      // режим инклинометра, малый шум, ФНЧ 10 Гц
static const uint32_t ENABLE_ANGLES = 0xB0001F6F;
static const uint32_t SW_RESET = 0xB4002098;
static const uint8_t WHOAMI_VALUE = 0xC1;
static const float LSB_PER_G_MODE4 = 12000.0f;

uint8_t crc8(uint32_t frame);  // по битам 31..8, как в даташите
// Разбор ответа: rs — статус (1 = норма), data — 16 бит данных. false — ошибка CRC.
bool decode(uint32_t frame, int& rs, int16_t& data);
inline float tempC(int16_t raw) { return -273.0f + raw / 18.9f; }
}  // namespace scl3300

// ---------- обработка и слияние ----------
struct FusionParams {
  float tau;           // постоянная времени фильтра, с
  float faultDeg;      // расхождение датчика с медианой, после которого он исключается, °
  float faultTime;     // сколько расхождение должно держаться, с
  float noiseFaultDeg; // порог шума, °
  float stuckTime;     // показания не меняются столько при движении остальных — «завис», с
  float resolution;    // разрешение датчика, °
};

FusionParams defaultParams();

struct SensorState {
  bool present;     // датчик ответил при старте
  bool readOk;      // последнее чтение успешно
  bool healthy;     // участвует в слиянии
  char reason[24];  // почему исключён
  // фильтрованный наклон без калибровки и с калибровкой, °
  double ux, uy;
  double x, y;
  double offX, offY;  // смещения нуля (калибровка)
  double rawX, rawY;  // последний отсчёт без фильтра (с калибровкой)
  float tempC;
  float noise;        // оценка шума, °
  // служебное
  bool init;
  double lastX, lastY, prevRes[2];
  bool hasPrevRes;
  float devT, sameT;
  double sameRefX, sameRefY;
  bool sameRefValid;
  double relBias[2];
  uint32_t errors;
};

struct Fused {
  double x, y;
  bool valid;
  int used;
};

class Fusion {
 public:
  Fusion();
  void setParams(const FusionParams& p) { p_ = p; }
  const FusionParams& params() const { return p_; }
  void setCount(int n);
  int count() const { return n_; }
  void setPresent(int i, bool present);
  // Цикл: setDt(dt) → update() для каждого датчика → fuse()
  void setDt(double dt) { pendingDt_ = dt; }
  // Новый отсчёт датчика i: ok=false — ошибка чтения
  void update(int i, bool ok, double tiltX, double tiltY, float tempC);
  // Слияние после обновления всех датчиков
  void fuse();
  const SensorState& sensor(int i) const { return s_[i]; }
  const Fused& fused() const { return f_; }
  void setOffsets(int i, double ox, double oy);
  void zeroAll();      // текущие показания принять за ноль
  void clearOffsets();
  void resetHealth();  // вернуть исключённые датчики в работу

 private:
  void exclude(int i, const char* why);
  bool othersRef(int i, double& rx, double& ry) const;
  FusionParams p_;
  SensorState s_[MAX_SENSORS];
  Fused f_;
  int n_;
  double pairPrev_[2];
  bool pairPrevValid_;
  float pairNoise_, pairT_;
  int lastUsed_;
  double pendingDt_;
};

double median3(double a, double b, double c);

// ---------- самовыравнивание сервоприводами с рычагом ----------
// Каждая опора i в точке (x, y) поднимается на z мм (рычаг: z = L·sin θ). Интегральный регулятор:
// z_i -= ki·ε_i·dt, где ε_i = tg(X)·x_i + tg(Y)·y_i — насколько опора выше горизонта через центр.
enum LevelState { LV_MANUAL = 0, LV_LEVELING = 1, LV_LEVEL = 2, LV_LIMIT = 3, LV_NO_DATA = 4 };

struct LevelerParams {
  float ki;        // 1/с
  float kh;        // подтягивание средней высоты к уставке, 1/с
  float tol;       // допуск, °
  float restart;   // в удержании: снова выравнивать при наклоне больше, °
  float confirm;   // сколько держать допуск, чтобы считать «ровно», с
  float vMax;      // скорость опоры, мм/с
  float zMax;      // ход опоры от нейтрали, ± мм
};
LevelerParams defaultLevelerParams();

class Leveler {
 public:
  Leveler();
  void setGeometry(const float pos[][2], int n);
  void setParams(const LevelerParams& p) { p_ = p; }
  const LevelerParams& params() const { return p_; }
  void setAuto(bool on);
  bool isAuto() const { return auto_; }
  void setHeight(float h);              // средний подъём опор относительно нейтрали, мм
  float height() const { return h_; }
  void setManual(int i, float z);       // ручная установка опоры (выключает авто)
  void home();                          // все опоры в нейтраль, авто выкл
  void update(double dt, bool valid, double tiltX, double tiltY);
  float z(int i) const { return z_[i]; }
  int state() const { return st_; }

 private:
  float pos_[MAX_SENSORS][2];
  float z_[MAX_SENSORS];
  int n_;
  LevelerParams p_;
  bool auto_;
  float h_, okT_;
  int st_;
};

// угол рычага (°) для подъёма z при длине рычага L; z вне ±L ограничивается
double leverAngle(double z, double L);
// наклон плоскости через три опоры (x, y, z), °
void planeTilt(const float pos[][2], const float z[3], double& tiltX, double& tiltY);

// ---------- команды (текстом, по строке) ----------
enum CommandType { CMD_NONE, CMD_INFO, CMD_ZERO, CMD_CLEAR, CMD_OFFSETS, CMD_TAU, CMD_RATE, CMD_RESET, CMD_SIM,
                   CMD_AUTO, CMD_HOME, CMD_HEIGHT, CMD_SERVO, CMD_KI, CMD_TOL, CMD_UNKNOWN };
struct Command {
  CommandType type;
  double v[6];
  int nv;
};
Command parseCommand(const char* line);

// JSON-строка с текущим состоянием. Возвращает длину (обрезается по cap).
// lv — состояние самовыравнивания (NULL, если сервоприводов нет).
int formatState(char* out, size_t cap, uint32_t tMs, const Fusion& fu, float sampleHz, const char* sensorType, const Leveler* lv = NULL);

}  // namespace lev
