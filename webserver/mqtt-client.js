import mqtt from "mqtt";
import readline from "readline";

const MQTT_HOST = process.env.MQTT_HOST || "localhost";
const MQTT_PORT = process.env.MQTT_PORT || 2000;
const MQTT_USER = process.env.MQTT_USER || "user";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "pass";

const TOPIC_PACKAGE_EXISTS = "package_exists";
const TOPIC_USER_HANDLED = "user_handled";

// State
let packageExists = false;
let inCooldown = false;
let cooldownTimer = null;
const COOLDOWN_DURATION_MS = 10 * 1000; // 10 seconds

function timestamp() {
  return new Date().toLocaleTimeString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function updateLedDisplay() {
  if (packageExists && !inCooldown) {
    console.log("\n>>> LED FLASHING STARTED <<<\n");
  } else {
    console.log("\n>>> LED OFF <<<\n");
  }
}

// ============================================
// MQTT Connection
// ============================================

const clientId = `simulated-mcu-${Math.random().toString(16).slice(2, 8)}`;
const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  clientId,
  username: MQTT_USER,
  password: MQTT_PASSWORD,
});

client.on("connect", () => {
  console.clear();
  console.log("===========================================");
  console.log("  Simulated Microcontroller - Connected");
  console.log("===========================================");
  console.log("Controls:");
  console.log("  [b] - Simulate button press");
  console.log("  [q] - Quit");
  console.log("===========================================\n");

  client.subscribe([TOPIC_PACKAGE_EXISTS, TOPIC_USER_HANDLED], (err) => {
    if (err) {
      console.error("Failed to subscribe:", err);
    } else {
      log(`Subscribed to: ${TOPIC_PACKAGE_EXISTS}, ${TOPIC_USER_HANDLED}`);
    }
  });
});

client.on("message", (topic, payload) => {
  const message = payload.toString();
  log(`Received on ${topic}: ${message}`);

  try {
    const data = JSON.parse(message);

    if (topic === TOPIC_PACKAGE_EXISTS) {
      const newPackageExists = data.exists === true;

      if (newPackageExists !== packageExists) {
        packageExists = newPackageExists;

        if (!packageExists) {
          // Package removed - clear cooldown
          if (cooldownTimer) {
            clearTimeout(cooldownTimer);
            cooldownTimer = null;
          }
          inCooldown = false;
        }

        updateLedDisplay();
      }
    } else if (topic === TOPIC_USER_HANDLED) {
      if (data.handled === true) {
        log("User handled - entering cooldown");
        enterCooldown();
      }
    }
  } catch {
    log(`Failed to parse message: ${message}`);
  }
});

client.on("error", (err) => {
  console.error("MQTT Error:", err.message);
});

client.on("close", () => {
  log("Connection closed");
});

// ============================================
// Cooldown Logic
// ============================================

function enterCooldown() {
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
  }

  inCooldown = true;
  console.log("\n>>> LED FLASHING STOPPED (user handled) <<<\n");

  cooldownTimer = setTimeout(() => {
    log("Cooldown complete");
    inCooldown = false;
    cooldownTimer = null;

    if (packageExists) {
      updateLedDisplay();
    }
  }, COOLDOWN_DURATION_MS);

  log(`Cooldown active for ${COOLDOWN_DURATION_MS / 1000} seconds`);
}

// ============================================
// Button Press Simulation
// ============================================

function simulateButtonPress() {
  if (!packageExists) {
    log("Button press ignored - no package detected");
    return;
  }

  if (inCooldown) {
    log("Button press ignored - in cooldown");
    return;
  }

  log("Publishing user_handled...");

  const message = JSON.stringify({
    handled: true,
    timestamp: new Date().toISOString(),
    source: "simulated-mcu",
  });

  client.publish(TOPIC_USER_HANDLED, message, { qos: 1 }, (err) => {
    if (err) {
      log(`Publish failed: ${err.message}`);
    } else {
      log("Published successfully");
    }
  });
}

// ============================================
// Keyboard Input
// ============================================

readline.emitKeypressEvents(process.stdin);

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on("keypress", (str, key) => {
  if (key.ctrl && key.name === "c") {
    shutdown();
    return;
  }

  switch (key.name) {
    case "b":
      simulateButtonPress();
      break;
    case "q":
      shutdown();
      break;
    default:
      // Ignore other keys
      break;
  }
});

// ============================================
// Shutdown
// ============================================

function shutdown() {
  console.log("\nShutting down...");

  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
  }

  client.end(false, () => {
    console.log("Disconnected");
    process.exit(0);
  });

  // Force exit after 2 seconds
  setTimeout(() => {
    process.exit(1);
  }, 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
