import "dotenv/config";
import mqtt from "mqtt";
import { logger } from "./logger.js";

const MQTT_HOST = process.env.MQTT_HOST || "localhost";
const MQTT_PORT = process.env.MQTT_PORT || 2000;
const MQTT_USER = process.env.MQTT_USER || "user";
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "pass";

const TOPIC_PACKAGE_EXISTS = "package_exists";

let client = null;

/**
 * Connect to the MQTT broker
 * @returns {Promise<void>}
 */
export async function connect() {
  return new Promise((resolve, reject) => {
    const clientId = `capture-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    logger.info(`Connecting to MQTT broker at ${MQTT_HOST}:${MQTT_PORT}`);

    client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
      clientId,
      username: MQTT_USER,
      password: MQTT_PASSWORD,
      connectTimeout: 10000,
      reconnectPeriod: 0, // Don't auto-reconnect for one-shot capture
    });

    client.on("connect", () => {
      logger.info("Connected to MQTT broker", { clientId });
      resolve();
    });

    client.on("error", (err) => {
      logger.error("MQTT connection error", { error: err.message });
      reject(err);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!client.connected) {
        reject(new Error("MQTT connection timeout"));
      }
    }, 10000);
  });
}

/**
 * Publish package detection status
 * @param {boolean} packageExists - Whether a package was detected
 * @returns {Promise<void>}
 */
export async function publishPackageStatus(packageExists) {
  return new Promise((resolve, reject) => {
    if (!client || !client.connected) {
      reject(new Error("MQTT client not connected"));
      return;
    }

    const message = JSON.stringify({
      exists: packageExists,
      timestamp: new Date().toISOString(),
    });

    logger.info(`Publishing to ${TOPIC_PACKAGE_EXISTS}`, { packageExists });

    client.publish(
      TOPIC_PACKAGE_EXISTS,
      message,
      {
        qos: 1,
        retain: true, // Retain message so new subscribers get last state
      },
      (err) => {
        if (err) {
          logger.error("Failed to publish package status", {
            error: err.message,
          });
          reject(err);
        } else {
          logger.info("Package status published successfully", {
            packageExists,
          });
          resolve();
        }
      }
    );
  });
}

/**
 * Disconnect from the MQTT broker
 * @returns {Promise<void>}
 */
export async function disconnect() {
  return new Promise((resolve) => {
    if (!client) {
      resolve();
      return;
    }

    logger.info("Disconnecting from MQTT broker");

    client.end(false, () => {
      logger.info("Disconnected from MQTT broker");
      client = null;
      resolve();
    });

    // Force disconnect after 2 seconds
    setTimeout(() => {
      if (client) {
        client = null;
      }
      resolve();
    }, 2000);
  });
}

/**
 * Check if connected to MQTT broker
 * @returns {boolean}
 */
export function isConnected() {
  return client && client.connected;
}
