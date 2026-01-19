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
| `lib/package-detector.js` | Claude/Gemini API integration for package detection |
| `lib/mqtt-client.js` | MQTT constants and client utilities |
| `lib/slack-notifier.js` | Slack notifications when packages are detected |

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
- `ANTHROPIC_API_KEY` - Claude API key (required if using Claude)
- `GOOGLE_AI_API_KEY` - Google AI API key (required if using Gemini)
- `MODEL` - Model to use: `claude` (default) or `gemini`
- `MQTT_USER` / `MQTT_PASSWORD` - MQTT broker credentials
- `SLACK_BOT_TOKEN` - Slack bot token for notifications (optional)
- `SLACK_CHANNEL_ID` - Slack channel ID for notifications (optional)
- `DEPLOY_HOST` - Production server IP for deployment

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

### 5. Slack Notifications (Optional)

To receive Slack notifications when packages are detected:

1. Create a Slack app at https://api.slack.com/apps using `slack-app-manifest.yaml`
2. Install the app to your workspace
3. Copy the Bot User OAuth Token (`xoxb-...`) from OAuth & Permissions
4. Get the channel ID (right-click channel → View channel details → scroll to bottom)
5. Add to `.env`:
   ```
   SLACK_BOT_TOKEN=xoxb-your-token
   SLACK_CHANNEL_ID=C0123456789
   ```
6. Invite the bot to your channel: `/invite @Chase Bot`

### 6. Systemd Services (Production)

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

## Deployment

Deploy changes to the production server:

```bash
npm run deploy
```

This pulls the latest code and restarts the services on the server defined by `DEPLOY_HOST` in `.env`.

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

### Test Model Detection

Test package detection with a sample image:

```bash
# Test with Claude (default)
npm run test-model -- package-detection-eval/package-exists/frame_T8203P1224450F4B_1767393931512_000001.jpg

# Test with Gemini
MODEL=gemini npm run test-model -- package-detection-eval/package-exists/frame_T8203P1224450F4B_1767393931512_000001.jpg

# Test with a no-package image
npm run test-model -- package-detection-eval/no-package/frame_T8203P1224450F4B_1767394055496_000001.jpg
```

### Test Slack Notifications

Verify Slack integration is working:

```bash
npm run test-slack -- package-detection-eval/package-exists/frame_T8203P1224450F4B_1767393931512_000001.jpg
```

**Note:** You must first invite the bot to your Slack channel: `/invite @Chase Bot`

## MQTT Topics

| Topic | Direction | Payload |
|-------|-----------|---------|
| `package_exists` | Publish | `{"exists": true/false, "timestamp": "..."}` |
| `user_handled` | Sub/Pub | `{"handled": true, "timestamp": "..."}` |

## Healthcheck

```bash
curl http://localhost:3000/healthcheck
```

Returns `200 OK` if both conditions are met:
- **Capture**: `package_exists` message received within the last 2 minutes
- **ESP8266 clients**: At least 4 clients with `ESP8266` prefix connected (5 minute grace period after dropping below)

Example response:
```json
{
  "healthy": true,
  "capture": {
    "lastMessageAt": "2025-01-03T12:00:00.000Z",
    "secondsAgo": 45
  },
  "espClients": {
    "count": 4,
    "required": 4,
    "belowForSec": null
  }
}
```

## Directory Structure

```
eufy-cam/
├── capture.js              # Main capture + detection script
├── package.json            # Dependencies
├── .env                    # Credentials (gitignored)
├── .env.default            # Template
├── slack-app-manifest.yaml # Slack app manifest for setup
├── lib/
│   ├── logger.js           # Winston logging
│   ├── package-detector.js # Claude API
│   └── mqtt-client.js      # MQTT constants and client utilities
├── scripts/
│   ├── deploy.sh              # Deploy to production server
│   ├── simulate-led-button.js # Simulated MCU for testing
│   ├── simulate-package.js    # Simulate package detection
│   ├── test-model.js          # Test package detection with an image
│   └── test-slack.js          # Test Slack notification
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
├── package-detection-eval/
│   ├── run-eval.js         # Evaluation script
│   ├── no-package/         # Sample images without packages
│   └── package-exists/     # Sample images with packages
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
