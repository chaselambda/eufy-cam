# Package Notification Button Firmware

ESP8266 firmware for LED notification and button acknowledgment of package detection.

## Hardware

- **Board**: NodeMCU v2 (ESP8266)
- **LED**: Connected to D2 (GPIO4) - active LOW (LED connected to 5V, pull LOW to turn on)
- **Button**: Connected to D1 (GPIO5) - uses internal pull-up, pressing grounds to LOW

## Wiring

```
ESP8266 NodeMCU v2
┌──────────────────────┐
│                      │
│ D2 (GPIO4) ──────────┼──── LED (-) ──── LED (+) ──── 5V
│                      │           (pull LOW to turn on)
│                      │
│ D1 (GPIO5) ──────────┼──── Button ──── GND
│                      │     (internal pull-up, press to ground)
│                      │
└──────────────────────┘
```

## Configuration

Copy `src/config.h.default` to `src/config.h` and update:

```cpp
#define WIFI_SSID "YOUR_WIFI_SSID"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define MQTT_SERVER "YOUR_MQTT_SERVER_IP"
#define MQTT_PORT 2000
#define MQTT_USER "your_mqtt_user"
#define MQTT_PASSWORD "your_mqtt_password"
```

Note: `config.h` is gitignored to protect credentials.

## MQTT Topics

| Topic | Direction | Payload |
|-------|-----------|---------|
| `led_flashing` | Subscribe | `{"flashing": true/false}` |
| `user_handled` | Publish | `{"handled": true, "timestamp": ...}` |

## Behavior

1. **LED flashes** (500ms on/off) when server sends `led_flashing: true`
2. **LED off** when server sends `led_flashing: false`
3. **Button press**:
   - Immediately turns LED off (low latency UX)
   - Publishes `user_handled: true` to server
   - Server manages cooldown and state logic

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
