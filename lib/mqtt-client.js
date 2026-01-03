import "dotenv/config";
import mqtt from "mqtt";
import { logger } from "./logger.js";

// ============================================
// MQTT Configuration
// ============================================

export const MQTT_HOST = process.env.MQTT_HOST || "localhost";
export const MQTT_PORT = process.env.MQTT_PORT || 2000;
export const MQTT_USER = process.env.MQTT_USER || "user";
export const MQTT_PASSWORD = process.env.MQTT_PASSWORD || "pass";

// ============================================
// MQTT Topics
// ============================================

export const TOPIC_PACKAGE_EXISTS = "package_exists";
export const TOPIC_USER_HANDLED = "user_handled";
export const TOPIC_LED_FLASHING = "led_flashing";

// ============================================
// Client Management
// ============================================

/**
 * Create and connect an MQTT client
 * @param {string} clientIdPrefix - Prefix for the client ID
 * @returns {Promise<mqtt.MqttClient>} Connected MQTT client
 */
export async function createClient(clientIdPrefix) {
  return new Promise((resolve, reject) => {
    const clientId = `${clientIdPrefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

    logger.info(`Connecting to MQTT broker at ${MQTT_HOST}:${MQTT_PORT}`);

    const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
      clientId,
      username: MQTT_USER,
      password: MQTT_PASSWORD,
      connectTimeout: 10000,
      reconnectPeriod: 0, // Don't auto-reconnect for one-shot capture
    });

    client.on("connect", () => {
      logger.info("Connected to MQTT broker", { clientId });
      resolve(client);
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
 * @param {mqtt.MqttClient} client - Connected MQTT client
 * @param {boolean} packageExists - Whether a package was detected
 * @returns {Promise<void>}
 */
export async function publishPackageStatus(client, packageExists) {
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
 * Disconnect an MQTT client
 * @param {mqtt.MqttClient} client - MQTT client to disconnect
 * @returns {Promise<void>}
 */
export async function disconnect(client) {
  return new Promise((resolve) => {
    if (!client) {
      resolve();
      return;
    }

    logger.info("Disconnecting from MQTT broker");

    client.end(false, () => {
      logger.info("Disconnected from MQTT broker");
      resolve();
    });

    // Force disconnect after 2 seconds
    setTimeout(() => {
      resolve();
    }, 2000);
  });
}
