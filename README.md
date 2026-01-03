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
| `capture-continuous.js` | Continuous capture (buggy - times out after ~25s) |
| `webserver/server.js` | MQTT broker (port 2000) + HTTP healthcheck (port 3000) |
| `scripts/simulate-led-button.js` | Simulated MCU for testing without hardware |
| `button_firmware/` | ESP8266 PlatformIO project for LED notification buttons |
| `lib/logger.js` | Winston structured logging |
| `lib/package-detector.js` | Claude API integration for package detection |
| `lib/mqtt-client.js` | MQTT constants and client utilities |

## Setup

### 1. Prerequisites (Ubuntu Server)

Install required system packages:

```bash
# FFmpeg for video frame extraction
sudo apt update
sudo apt install -y ffmpeg

# NVM for Node.js version management
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc

# Install Node.js (v20 recommended)
nvm install 20
nvm use 20
```

Configure journald for persistent logs (default is memory-only):

```bash
sudo vim /etc/systemd/journald.conf
```

Add:
```
Storage=persistent
RateLimitInterval=0
```

Then restart journald:
```bash
sudo systemctl restart systemd-journald
```

### 2. Configuration

Clone the repo and configure both the server and ESP8266 firmware:

```bash
# Server configuration
cp .env.default .env
```

Edit `.env` with your credentials:
- `EUFY_USERNAME` / `EUFY_PASSWORD` - Eufy account credentials
- `ANTHROPIC_API_KEY` - Claude API key
- `MQTT_USER` / `MQTT_PASSWORD` - MQTT broker credentials

```bash
# ESP8266 firmware configuration
cp button_firmware/src/config.h.default button_firmware/src/config.h
```

Edit `button_firmware/src/config.h`:
- `WIFI_SSID` / `WIFI_PASSWORD` - Your WiFi credentials
- `MQTT_SERVER` - IP address of the machine running the MQTT broker
- `MQTT_PORT` / `MQTT_USER` / `MQTT_PASSWORD` - Must match your `.env`

### 3. Install Dependencies

```bash
npm install
```

### 4. Flash ESP8266 Firmware

```bash
cd button_firmware
make upload
```

See `button_firmware/README.md` for wiring and detailed instructions.

### 5. Systemd Services (Production)

Install both services for production deployment:

```bash
# Copy service files
sudo cp webserver/eufy-mqtt.service /etc/systemd/system/
sudo cp webserver/eufy-capture.service /etc/systemd/system/
```

**Important:** The service files have a hardcoded Node.js path (`/root/.nvm/versions/node/v20.10.0/bin/node`). Update this path if your Node.js installation differs.

Enable and start the services:

```bash
sudo systemctl daemon-reload
sudo systemctl enable eufy-mqtt eufy-capture
sudo systemctl start eufy-mqtt eufy-capture
```

View logs:

```bash
journalctl -u eufy-mqtt -f
journalctl -u eufy-capture -f
```

## Running (Development)

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
└── captured/
    ├── snapshots/          # JPEG frames
    ├── snapshots_annotated/ # Frames with detection overlay
    └── videos/             # Raw video files
```

## Debugging

- Set `LOG_TIMESTAMPS=1` to include timestamps in log output
- Check healthcheck: `curl localhost:3000/healthcheck`
- Debug false positives by reviewing annotated images:
  ```bash
  rsync -avz root@YOUR_SERVER:/root/eufy-cam/captured/snapshots_annotated /tmp/
  open /tmp/snapshots_annotated  # macOS
  ```

## Known Issues

- **capture-continuous.js times out after ~25s**: The Eufy livestream disconnects after approximately 25 seconds. This appears to be a limitation of the eufy-security-client library or the Eufy P2P protocol. Use `capture.js --loop` for reliable periodic capture instead.
