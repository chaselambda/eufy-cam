import "dotenv/config";
import Aedes from "aedes";
import net from "net";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MQTT_PORT = process.env.MQTT_PORT || 2000;
const MQTT_USER = process.env.MQTT_USER || "user";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "pass";
const HTTP_PORT = 3000;
const LOGS_DIR = path.join(__dirname, "..", "logs");
const CAPTURE_LOG = path.join(LOGS_DIR, "capture.log");
const DATA_DIR = path.join(__dirname, "..", "data");
const COOLDOWN_STATE_FILE = path.join(DATA_DIR, "cooldown-state.json");
const HEALTHCHECK_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const COOLDOWN_DURATION_MS = 10 * 1000; // 2 minutes

// ============================================
// MQTT Topics
// ============================================

const TOPIC_PACKAGE_EXISTS = "package_exists";
const TOPIC_USER_HANDLED = "user_handled";
const TOPIC_LED_FLASHING = "led_flashing";

// ============================================
// LED State Management
// ============================================

let packageExists = false;
let inCooldown = false;
let cooldownTimer = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function formatPSTTimestamp() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }) + " PST";
}

function writeCooldownState(cooldownActive) {
  ensureDataDir();
  const state = {
    inCooldown: cooldownActive,
    startedAt: formatPSTTimestamp(),
  };
  fs.writeFileSync(COOLDOWN_STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[Cooldown] State written: inCooldown=${cooldownActive}`);
}

function publishLedFlashing(flashing) {
  const payload = JSON.stringify({ flashing });
  aedes.publish({
    topic: TOPIC_LED_FLASHING,
    payload: Buffer.from(payload),
    qos: 1,
    retain: true,
  });
  console.log(`[LED] Published led_flashing: ${flashing}`);
}

function updateLedState() {
  // LED should flash when package exists AND not in cooldown
  const shouldFlash = packageExists && !inCooldown;
  publishLedFlashing(shouldFlash);
}

function startCooldown() {
  // Clear any existing timer
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
  }

  inCooldown = true;
  writeCooldownState(true);
  updateLedState(); // LED off during cooldown

  // Set timer to clear cooldown after duration
  cooldownTimer = setTimeout(() => {
    inCooldown = false;
    writeCooldownState(false);
    cooldownTimer = null;
    console.log("[Cooldown] Cooldown period ended - waiting for next capture.js check");
    // Don't publish led_flashing here - let capture.js send package_exists
    // to trigger LED if package is still present
  }, COOLDOWN_DURATION_MS);

  console.log(`[Cooldown] Started ${COOLDOWN_DURATION_MS / 1000}s cooldown`);
}

function clearCooldown() {
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  inCooldown = false;
  writeCooldownState(false);
  console.log("[Cooldown] Cleared early (package removed)");
  // Note: updateLedState() called separately when package_exists changes
}

// ============================================
// MQTT Broker (Aedes)
// ============================================

const aedes = new Aedes();
const mqttServer = net.createServer(aedes.handle);

// Authentication
aedes.authenticate = (client, username, password, callback) => {
  const pwd = password ? Buffer.from(password).toString() : "";
  if (username === MQTT_USER && pwd === MQTT_PASSWORD) {
    console.log(`[MQTT] Auth success for ${client.id}`);
    return callback(null, true);
  }
  console.log(`[MQTT] Auth failed for ${client?.id}`);
  const error = new Error("Authentication failed");
  return callback(error, false);
};

// Connection events
aedes.on("client", (client) => {
  console.log(`[MQTT] Client connected: ${client?.id}`);
});

aedes.on("clientDisconnect", (client) => {
  console.log(`[MQTT] Client disconnected: ${client?.id}`);
});

aedes.on("subscribe", (subscriptions, client) => {
  const topics = subscriptions.map((s) => s.topic).join(", ");
  console.log(`[MQTT] ${client?.id} subscribed to: ${topics}`);
});

aedes.on("publish", (packet, client) => {
  if (client) {
    console.log(
      `[MQTT] ${client.id} published to ${packet.topic}: ${packet.payload.toString()}`
    );

    // Handle state-changing topics
    try {
      const payload = JSON.parse(packet.payload.toString());

      if (packet.topic === TOPIC_PACKAGE_EXISTS) {
        const newPackageExists = payload.exists === true;
        const stateChanged = newPackageExists !== packageExists;
        packageExists = newPackageExists;

        if (stateChanged) {
          console.log(`[State] packageExists changed to: ${packageExists}`);
          if (!packageExists) {
            console.log("[MQTT] Package removed - clearing cooldown");
            clearCooldown();
          }
        }

        // Always update LED state - handles case where cooldown ended
        // and capture.js confirms package still exists
        updateLedState();
      } else if (packet.topic === TOPIC_USER_HANDLED && payload.handled === true) {
        console.log("[MQTT] User handled package - starting cooldown");
        startCooldown();
      }
    } catch (e) {
      // Ignore non-JSON messages
    }
  }
});

mqttServer.listen(MQTT_PORT, () => {
  console.log(`[MQTT] Broker running on port ${MQTT_PORT}`);
});

// ============================================
// HTTP Healthcheck Server
// ============================================

function checkLogForRecentSuccess() {
  try {
    if (!fs.existsSync(CAPTURE_LOG)) {
      return {
        healthy: false,
        reason: "No capture log file found",
        lastCheck: null,
      };
    }

    const content = fs.readFileSync(CAPTURE_LOG, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    if (lines.length === 0) {
      return {
        healthy: false,
        reason: "Capture log is empty",
        lastCheck: null,
      };
    }

    // Find the most recent capture_success event
    const now = Date.now();
    let lastSuccessTime = null;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.event === "capture_success") {
          lastSuccessTime = new Date(entry.timestamp).getTime();
          break;
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    if (!lastSuccessTime) {
      return {
        healthy: false,
        reason: "No capture_success events found in log",
        lastCheck: null,
      };
    }

    const timeSinceSuccess = now - lastSuccessTime;

    if (timeSinceSuccess <= HEALTHCHECK_WINDOW_MS) {
      return {
        healthy: true,
        lastCheck: new Date(lastSuccessTime).toISOString(),
        secondsAgo: Math.floor(timeSinceSuccess / 1000),
      };
    }

    return {
      healthy: false,
      reason: `Last capture_success was ${Math.floor(timeSinceSuccess / 1000 / 60)} minutes ago`,
      lastCheck: new Date(lastSuccessTime).toISOString(),
    };
  } catch (error) {
    return {
      healthy: false,
      reason: `Error reading log: ${error.message}`,
      lastCheck: null,
    };
  }
}

const httpServer = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/healthcheck" || req.url === "/health") {
    const health = checkLogForRecentSuccess();
    res.writeHead(health.healthy ? 200 : 503);
    res.end(JSON.stringify(health, null, 2));
  } else if (req.url === "/") {
    res.writeHead(200);
    res.end(
      JSON.stringify(
        {
          service: "eufy-package-detector",
          mqtt_port: MQTT_PORT,
          endpoints: {
            healthcheck: "/healthcheck",
          },
        },
        null,
        2
      )
    );
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`[HTTP] Healthcheck server running on port ${HTTP_PORT}`);
  console.log(`[HTTP] Endpoints: http://localhost:${HTTP_PORT}/healthcheck`);
});

// ============================================
// Graceful Shutdown
// ============================================

function shutdown() {
  console.log("\nShutting down...");

  // Clear cooldown timer
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }

  aedes.close(() => {
    console.log("[MQTT] Broker closed");
  });

  mqttServer.close(() => {
    console.log("[MQTT] TCP server closed");
  });

  httpServer.close(() => {
    console.log("[HTTP] Server closed");
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    console.log("Forcing exit...");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("\n===========================================");
console.log("  Eufy Package Detection Server Started");
console.log("===========================================");
console.log(`  MQTT Broker: localhost:${MQTT_PORT}`);
console.log(`  HTTP Health: http://localhost:${HTTP_PORT}/healthcheck`);
console.log("===========================================\n");
