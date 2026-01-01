# Package Notification Button Firmware

ESP8266 firmware for LED notification and button acknowledgment of package detection.

## Hardware

- **Board**: NodeMCU v2 (ESP8266)
- **LED**: Connected to D2 (GPIO4) - active HIGH
- **Button**: Connected to D1 (GPIO5) - HIGH when pressed, LOW when released

## Wiring

```
ESP8266 NodeMCU v2
┌──────────────────────┐
│                      │
│ D2 (GPIO4) ──────────┼──── LED (+) ──── 220Ω ──── GND
│                      │
│ D1 (GPIO5) ──────────┼──── Button ──── 3.3V
│                      │     │
│ GND ─────────────────┼─────┴──── 10kΩ ──── GND (pull-down)
│                      │
└──────────────────────┘
```

## Configuration

Edit `src/main.cpp` and update:

```cpp
const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";
const char* mqtt_server = "YOUR_MQTT_SERVER_IP";
```

## MQTT Topics

| Topic | Direction | Payload |
|-------|-----------|---------|
| `package_exists` | Subscribe | `{"exists": true/false}` |
| `user_handled` | Subscribe + Publish | `{"handled": true, "timestamp": ...}` |

## Behavior

1. **LED flashes** (500ms on/off) when `package_exists: true`
2. **Button press** publishes `user_handled: true`
3. **Cooldown** (2 minutes) after button press - LED stops flashing
4. **Resume flashing** after cooldown if package still exists
5. **LED off** when `package_exists: false`

## Build & Upload

```bash
# Build
make build
# or: platformio run

# Upload to connected ESP8266
make upload
# or: platformio run -t upload

# Serial monitor
make monitor
# or: pio device monitor -b 115200
```

## Dependencies

- PlatformIO
- Libraries (auto-installed):
  - PubSubClient (MQTT)
  - ArduinoJson (JSON parsing)
