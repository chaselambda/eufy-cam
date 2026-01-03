# Eufy Package Detector

Package detection system that captures images from a Eufy doorbell camera, uses Claude AI to detect packages, and notifies ESP8266 microcontrollers via MQTT.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Eufy Camera    │────▶│   capture.js    │────▶│  Claude API     │
│  (Doorbell)     │     │  (Node.js)      │     │  (Vision)       │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   MQTT Broker   │
                        │   (Aedes)       │
                        └────────┬────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            ▼                    ▼                    ▼
    ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
    │   ESP8266     │   │   ESP8266     │   │   ESP8266     │
    │   Button 1    │   │   Button 2    │   │   Button N    │
    └───────────────┘   └───────────────┘   └───────────────┘
```

## Components

| Component | Description |
|-----------|-------------|
| `capture.js` | Main script - captures frames, detects packages, publishes to MQTT |
| `webserver/server.js` | MQTT broker (port 2000) + HTTP healthcheck (port 3000) |
| `scripts/simulate-led-button.js` | Simulated MCU for testing without hardware |
| `button_firmware/` | ESP8266 PlatformIO project for LED notification buttons |
| `lib/logger.js` | Winston structured logging |
| `lib/package-detector.js` | Claude API integration for package detection |
| `lib/mqtt-client.js` | MQTT constants and client utilities |

## Setup

### 1. Environment Configuration

```bash
cp .env.default .env
```

Edit `.env` with your credentials:
- `EUFY_USERNAME` / `EUFY_PASSWORD` - Eufy account credentials
- `ANTHROPIC_API_KEY` - Claude API key
- MQTT settings (defaults work for local broker)

### 2. Install Dependencies

```bash
npm install
```

### 3. Reference Image

Place a photo of your empty doorstep at:
```
reference/doorstep-reference.jpg
```

This is used by the AI to compare against captured frames.

### 4. ESP8266 Firmware (Optional)

```bash
cd button_firmware/src
cp config.h.default config.h
```

Edit `config.h` with your WiFi and MQTT settings:
- `WIFI_SSID` / `WIFI_PASSWORD` - Your WiFi credentials
- `MQTT_SERVER` - IP address of the machine running the MQTT broker
- `MQTT_PORT` / `MQTT_USER` / `MQTT_PASSWORD` - Must match your `.env`

Then flash:

```bash
cd button_firmware
make upload
```

## Running

### Start the MQTT Server

```bash
npm run server
# Starts MQTT broker on :2000 and HTTP healthcheck on :3000
```

### Run Capture (One-Shot)

```bash
npm run capture
```

### Run Capture Loop

```bash
npm run capture:loop            # Every 60 seconds (default)
node capture.js --loop 30s      # Custom interval
```

### Test with Simulated MCU

```bash
npm run simulate-led-button
# Press 'b' to simulate button press
# Press 'q' to quit
```

## MQTT Topics

| Topic | Direction | Payload |
|-------|-----------|---------|
| `package_exists` | Publish | `{"exists": true/false, "timestamp": "..."}` |
| `user_handled` | Sub/Pub | `{"handled": true, "timestamp": "..."}` |

## Healthcheck

```bash
curl http://localhost:3000/healthcheck
```

Returns `200 OK` if capture has succeeded in the last 30 minutes.

## Systemd Services

Install both services for production:

```bash
# Copy service files
sudo cp webserver/eufy-mqtt.service /etc/systemd/system/
sudo cp webserver/eufy-capture.service /etc/systemd/system/

# Reload and enable
sudo systemctl daemon-reload
sudo systemctl enable eufy-mqtt eufy-capture
sudo systemctl start eufy-mqtt eufy-capture
```

| Service | Description |
|---------|-------------|
| `eufy-mqtt` | MQTT broker + HTTP healthcheck |
| `eufy-capture` | Capture loop (runs every 60s) |

View logs:

```bash
journalctl -u eufy-mqtt -f
journalctl -u eufy-capture -f
```

## Directory Structure

```
eufy-cam/
├── capture.js              # Main capture + detection script
├── package.json            # Dependencies
├── .env                    # Credentials (gitignored)
├── .env.default            # Template
├── lib/
│   ├── logger.js           # Winston logging
│   ├── package-detector.js # Claude API
│   └── mqtt-client.js      # MQTT constants and client utilities
├── scripts/
│   ├── simulate-led-button.js # Simulated MCU for testing
│   └── simulate-package.js    # Simulate package detection
├── webserver/
│   ├── server.js           # MQTT broker + healthcheck
│   ├── eufy-mqtt.service   # Systemd service (broker)
│   └── eufy-capture.service # Systemd service (capture loop)
├── button_firmware/
│   ├── platformio.ini
│   ├── src/
│   │   ├── main.cpp
│   │   ├── config.h.default  # Template
│   │   └── config.h          # Your settings (gitignored)
│   ├── Makefile
│   └── README.md
├── reference/
│   └── doorstep-reference.jpg  # Reference image (gitignored)
└── captured/
    ├── snapshots/          # JPEG frames
    └── videos/             # Raw video files
```

## Debugging

- Set `LOG_TIMESTAMPS=1` to include timestamps in log output
- Check healthcheck: `curl localhost:3000/healthcheck`
- View service logs: `journalctl -u eufy-capture -f`
