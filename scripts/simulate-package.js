#!/usr/bin/env node

/**
 * Simulate package detection by publishing an MQTT message.
 *
 * Usage:
 *   node scripts/simulate-package.js           # Package detected (exists: true)
 *   node scripts/simulate-package.js true      # Package detected (exists: true)
 *   node scripts/simulate-package.js false     # Package removed (exists: false)
 */

import mqtt from "mqtt";

const MQTT_HOST = process.env.MQTT_HOST || "localhost";
const MQTT_PORT = process.env.MQTT_PORT || 2000;
const MQTT_USER = process.env.MQTT_USER || "user";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "pass";

const TOPIC_PACKAGE_EXISTS = "package_exists";

// Parse command-line argument (default to true if not provided)
const arg = process.argv[2];
const packageExists = arg === undefined || arg.toLowerCase() !== "false";

console.log(`Simulating package detection: exists=${packageExists}`);
console.log(`Connecting to MQTT broker at ${MQTT_HOST}:${MQTT_PORT}...`);

const clientId = `simulate-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  clientId,
  username: MQTT_USER,
  password: MQTT_PASSWORD,
  connectTimeout: 10000,
  reconnectPeriod: 0,
});

client.on("connect", () => {
  console.log("Connected to MQTT broker");

  const message = JSON.stringify({
    exists: packageExists,
    timestamp: new Date().toISOString(),
  });

  client.publish(
    TOPIC_PACKAGE_EXISTS,
    message,
    { qos: 1, retain: true },
    (err) => {
      if (err) {
        console.error("Failed to publish:", err.message);
        process.exit(1);
      }

      console.log(`Published to ${TOPIC_PACKAGE_EXISTS}: ${message}`);

      client.end(false, () => {
        console.log("Disconnected");
        process.exit(0);
      });
    }
  );
});

client.on("error", (err) => {
  console.error("MQTT connection error:", err.message);
  process.exit(1);
});

// Timeout after 10 seconds
setTimeout(() => {
  if (!client.connected) {
    console.error("Connection timeout");
    process.exit(1);
  }
}, 10000);
