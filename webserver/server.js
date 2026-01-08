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
const DATA_DIR = path.join(__dirname, "..", "data");
const COOLDOWN_STATE_FILE = path.join(DATA_DIR, "cooldown-state.json");
const HEALTHCHECK_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const COOLDOWN_DURATION_MS = 2 * 60 * 1000; // 2 minutes

// ============================================
// LED State Management
// ============================================

let packageExists = false;
let cooldownTimer = null;
let lastPackageExistsAt = null; // timestamp of last package_exists message
const serverStartedAt = Date.now();

// Track ESP8266 client connections
const espClients = new Set();
const MIN_ESP_CLIENTS = 3;
const ESP_GRACE_PERIOD_MS = 20 * 1000; // 5 minutes
let espBelowMinSince = null; // timestamp when count first dropped below MIN_ESP_CLIENTS

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
  if (client?.id?.startsWith("ESP8266")) {
    espClients.add(client.id);
    if (espClients.size >= MIN_ESP_CLIENTS) {
      espBelowMinSince = null; // Reset timer when we hit minimum
    }
  }
});

aedes.on("clientDisconnect", (client) => {
  logger.info("MQTT client disconnected", { clientId: client?.id });
  if (client?.id) {
    espClients.delete(client.id);
    if (espClients.size < MIN_ESP_CLIENTS && espBelowMinSince === null) {
      espBelowMinSince = Date.now(); // Start timer when we drop below minimum
    }
  }
});

aedes.on("subscribe", (subscriptions, client) => {
  const topics = subscriptions.map((s) => s.topic).join(", ");
  logger.info("MQTT client subscribed", { clientId: client?.id, topics });
});

aedes.on("publish", (packet, client) => {
  if (client) {
    logger.info("MQTT message received", {
      clientId: client.id,
      topic: packet.topic,
      payload: packet.payload.toString(),
    });

    // Handle state-changing topics
    try {
      const payload = JSON.parse(packet.payload.toString());

      if (packet.topic === TOPIC_PACKAGE_EXISTS) {
        lastPackageExistsAt = Date.now();
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
        if (packageExists) {
          logger.info("User handled package - starting cooldown");
          startCooldown();
        } else {
          logger.info("User button press ignored - no package present");
        }
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

function checkEspClients() {
  const now = Date.now();
  const count = espClients.size;

  // Healthy if we have enough clients, or if we dropped below recently (within grace period)
  let healthy = true;
  let belowForMs = null;

  if (count < MIN_ESP_CLIENTS) {
    if (espBelowMinSince === null) {
      espBelowMinSince = now; // First check after startup
    }
    belowForMs = now - espBelowMinSince;
    healthy = belowForMs < ESP_GRACE_PERIOD_MS;
  }

  return {
    healthy,
    count,
    required: MIN_ESP_CLIENTS,
    belowForMs,
  };
}

function checkCaptureHealth() {
  const now = Date.now();

  // If no message received yet, use server start time as baseline
  const baselineTime = lastPackageExistsAt || serverStartedAt;
  const timeSince = now - baselineTime;

  if (timeSince <= HEALTHCHECK_WINDOW_MS) {
    return {
      healthy: true,
      lastCheck: lastPackageExistsAt ? new Date(lastPackageExistsAt).toISOString() : null,
      secondsAgo: Math.floor(timeSince / 1000),
    };
  }

  if (!lastPackageExistsAt) {
    return {
      healthy: false,
      reason: "No package_exists message received since startup",
      lastCheck: null,
    };
  }

  return {
    healthy: false,
    reason: `Last package_exists was ${Math.floor(timeSince / 1000 / 60)} minutes ago`,
    lastCheck: new Date(lastPackageExistsAt).toISOString(),
  };
}

const httpServer = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/healthcheck" || req.url === "/health") {
    const captureHealth = checkCaptureHealth();
    const espHealth = checkEspClients();

    const healthy = captureHealth.healthy && espHealth.healthy;
    const reasons = [];
    if (!captureHealth.healthy) reasons.push(captureHealth.reason);
    if (!espHealth.healthy) {
      const mins = Math.floor(espHealth.belowForMs / 1000 / 60);
      reasons.push(`Only ${espHealth.count}/${espHealth.required} ESP8266 clients for ${mins}+ min`);
    }

    const health = {
      healthy,
      reason: reasons.length > 0 ? reasons.join("; ") : undefined,
      capture: {
        lastMessageAt: captureHealth.lastCheck,
        secondsAgo: captureHealth.secondsAgo,
      },
      espClients: {
        count: espHealth.count,
        required: espHealth.required,
        belowForSec: espHealth.belowForMs ? Math.floor(espHealth.belowForMs / 1000) : null,
      },
    };

    res.writeHead(healthy ? 200 : 503);
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
