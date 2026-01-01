import Aedes from "aedes";
import net from "net";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MQTT_PORT = 2000;
const HTTP_PORT = 3000;
const LOGS_DIR = path.join(__dirname, "..", "logs");
const CAPTURE_LOG = path.join(LOGS_DIR, "capture.log");
const HEALTHCHECK_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ============================================
// MQTT Broker (Aedes)
// ============================================

const aedes = new Aedes();
const mqttServer = net.createServer(aedes.handle);

// Authentication
aedes.authenticate = (client, username, password, callback) => {
  const pwd = password ? Buffer.from(password).toString() : "";
  if (username === "user" && pwd === "pass") {
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
