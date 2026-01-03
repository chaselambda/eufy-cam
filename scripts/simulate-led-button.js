import readline from "readline";
import {
  createClient,
  disconnect,
  TOPIC_LED_FLASHING,
  TOPIC_USER_HANDLED,
} from "../lib/mqtt-client.js";

// State
let ledFlashing = false;
let client = null;

function timestamp() {
  return new Date().toLocaleTimeString();
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function updateLedDisplay() {
  if (ledFlashing) {
    console.log("\n>>> LED FLASHING <<<\n");
  } else {
    console.log("\n>>> LED OFF <<<\n");
  }
}

// ============================================
// MQTT Connection
// ============================================

async function connect() {
  try {
    client = await createClient("simulated-mcu");

    console.clear();
    console.log("===========================================");
    console.log("  Simulated Microcontroller - Connected");
    console.log("===========================================");
    console.log("Controls:");
    console.log("  [b] - Simulate button press");
    console.log("  [q] - Quit");
    console.log("===========================================\n");

    // Subscribe only to led_flashing - server handles all state logic
    client.subscribe(TOPIC_LED_FLASHING, (err) => {
      if (err) {
        console.error("Failed to subscribe:", err);
      } else {
        log(`Subscribed to: ${TOPIC_LED_FLASHING}`);
      }
    });

    client.on("message", (topic, payload) => {
      const message = payload.toString();
      log(`Received on ${topic}: ${message}`);

      try {
        const data = JSON.parse(message);

        if (topic === TOPIC_LED_FLASHING) {
          const newLedFlashing = data.flashing === true;

          if (newLedFlashing !== ledFlashing) {
            ledFlashing = newLedFlashing;
            updateLedDisplay();
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
  } catch (err) {
    console.error("Failed to connect:", err.message);
    process.exit(1);
  }
}

// ============================================
// Button Press Simulation
// ============================================

function simulateButtonPress() {
  if (!ledFlashing) {
    log("Button press ignored - LED not flashing");
    return;
  }

  log("Publishing user_handled...");

  // Immediately stop flashing for low latency UX
  // Server will confirm via led_flashing: false
  ledFlashing = false;
  console.log("\n>>> LED OFF <<<\n");

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

async function shutdown() {
  console.log("\nShutting down...");
  await disconnect(client);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the application
connect();
