import Aedes from "aedes";
import net from "net";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "../lib/logger.js";
import {
  TOPIC_PACKAGE_EXISTS,
  TOPIC_USER_HANDLED,
  TOPIC_LED_FLASHING,
} from "../lib/mqtt-client.js";

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
const COOLDOWN_DURATION_MS = 2 * 60 * 1000; // 2 minutes

// ============================================
// LED State Management
// ============================================

let packageExists = false;
let cooldownTimer = null;

function inCooldown() {
  return cooldownTimer !== null;
}

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
  logger.info("Cooldown state written", { inCooldown: cooldownActive });
}

function publishLedFlashing(flashing) {
  const payload = JSON.stringify({ flashing });
  aedes.publish({
    topic: TOPIC_LED_FLASHING,
    payload: Buffer.from(payload),
    qos: 1,
    retain: true,
  });
  logger.info("Published led_flashing", { flashing });
}

function updateLedState() {
  // LED should flash when package exists AND not in cooldown
  const shouldFlash = packageExists && !inCooldown();
  publishLedFlashing(shouldFlash);
}

function startCooldown() {
  // Clear any existing timer
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
  }

  writeCooldownState(true);
  // Set timer to clear cooldown after duration
  cooldownTimer = setTimeout(() => {
    cooldownTimer = null;
    writeCooldownState(false);
    logger.info("Cooldown period ended - waiting for next capture.js check");
    // Don't publish led_flashing here - let capture.js send package_exists
    // to trigger LED if package is still present
  }, COOLDOWN_DURATION_MS);

  updateLedState(); // LED off during cooldown
  logger.info("Cooldown started", { durationSeconds: COOLDOWN_DURATION_MS / 1000 });
}

function clearCooldown() {
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
    writeCooldownState(false);
    logger.info("Cooldown cleared early (package removed)");
  }
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
    logger.info("MQTT auth success", { clientId: client.id });
    return callback(null, true);
  }
  logger.warn("MQTT auth failed", { clientId: client?.id });
  const error = new Error("Authentication failed");
  return callback(error, false);
};

// Connection events
aedes.on("client", (client) => {
  logger.info("MQTT client connected", { clientId: client?.id });
});

aedes.on("clientDisconnect", (client) => {
  logger.info("MQTT client disconnected", { clientId: client?.id });
});

aedes.on("subscribe", (subscriptions, client) => {
  const topics = subscriptions.map((s) => s.topic).join(", ");
  logger.info("MQTT client subscribed", { clientId: client?.id, topics });
});

aedes.on("publish", (packet, client) => {
  if (client) {
    logger.info("MQTT message published", {
      clientId: client.id,
      topic: packet.topic,
      payload: packet.payload.toString(),
    });

    // Handle state-changing topics
    try {
      const payload = JSON.parse(packet.payload.toString());

      if (packet.topic === TOPIC_PACKAGE_EXISTS) {
        const newPackageExists = payload.exists === true;
        const stateChanged = newPackageExists !== packageExists;
        packageExists = newPackageExists;

        if (stateChanged) {
          logger.info("Package state changed", { packageExists });
          if (!packageExists) {
            logger.info("Package removed - clearing cooldown");
            clearCooldown();
          }
        }

        // Always update LED state - handles case where cooldown ended
        // and capture.js confirms package still exists
        updateLedState();
      } else if (packet.topic === TOPIC_USER_HANDLED && payload.handled === true) {
        logger.info("User handled package - starting cooldown");
        startCooldown();
      }
    } catch (e) {
      // Ignore non-JSON messages
    }
  }
});

mqttServer.listen(MQTT_PORT, () => {
  logger.info("MQTT broker running", { port: MQTT_PORT });
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
  logger.info("HTTP healthcheck server running", {
    port: HTTP_PORT,
    endpoint: `http://localhost:${HTTP_PORT}/healthcheck`,
  });
});

// ============================================
// Graceful Shutdown
// ============================================

function shutdown() {
  logger.info("Shutting down...");

  // Clear cooldown timer
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }

  aedes.close(() => {
    logger.info("MQTT broker closed");
  });

  mqttServer.close(() => {
    logger.info("MQTT TCP server closed");
  });

  httpServer.close(() => {
    logger.info("HTTP server closed");
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    logger.warn("Forcing exit...");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

logger.info("Eufy Package Detection Server Started", {
  mqttBroker: `localhost:${MQTT_PORT}`,
  httpHealth: `http://localhost:${HTTP_PORT}/healthcheck`,
});
