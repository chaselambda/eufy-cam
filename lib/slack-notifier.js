import "dotenv/config";
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;

/**
 * Check if Slack notifications are configured
 */
export function isSlackConfigured() {
  return Boolean(SLACK_BOT_TOKEN && SLACK_CHANNEL_ID);
}

/**
 * Upload an image to Slack and post a message
 * @param {string} imagePath - Path to the image file
 * @param {object} result - Detection result {package_detected, description}
 */
export async function notifyPackageDetected(imagePath, result) {
  if (!isSlackConfigured()) {
    logger.warn("Slack not configured, skipping notification");
    return;
  }

  const message = result.package_detected
    ? `:package: *Package detected on doorstep!*\n${result.description}`
    : `:white_check_mark: No package detected\n${result.description}`;

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const filename = path.basename(imagePath);
    const fileSize = imageBuffer.length;

    // Step 1: Get upload URL
    const urlResponse = await fetch(
      `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${fileSize}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        },
      }
    );

    const urlData = await urlResponse.json();
    if (!urlData.ok) {
      throw new Error(`getUploadURLExternal: ${urlData.error}`);
    }

    // Step 2: Upload file to the URL
    const uploadResponse = await fetch(urlData.upload_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: imageBuffer,
    });

    if (!uploadResponse.ok) {
      throw new Error(`File upload failed: ${uploadResponse.status}`);
    }

    // Step 3: Complete the upload
    const completeResponse = await fetch(
      "https://slack.com/api/files.completeUploadExternal",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          files: [{ id: urlData.file_id, title: filename }],
          channel_id: SLACK_CHANNEL_ID,
          initial_comment: message,
        }),
      }
    );

    const completeData = await completeResponse.json();
    if (!completeData.ok) {
      throw new Error(`completeUploadExternal: ${completeData.error}`);
    }

    logger.info("Slack notification sent", { filename });
  } catch (error) {
    logger.error("Failed to send Slack notification", { error: error.message });
  }
}

/**
 * Send a text-only Slack message (no image)
 * @param {string} message - Message to send
 */
async function sendTextMessage(message) {
  if (!isSlackConfigured()) {
    logger.warn("Slack not configured, skipping notification");
    return;
  }

  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: SLACK_CHANNEL_ID,
        text: message,
      }),
    });

    const data = await response.json();
    if (!data.ok) {
      throw new Error(`chat.postMessage: ${data.error}`);
    }

    logger.info("Slack text message sent");
  } catch (error) {
    logger.error("Failed to send Slack message", { error: error.message });
  }
}

/**
 * Notify that a package was picked up (no longer detected)
 */
export async function notifyPackagePickedUp() {
  await sendTextMessage(":white_check_mark: *Package picked up!*\nThe package is no longer detected on the doorstep.");
}

/**
 * Notify that a user acknowledged the package via button press
 */
export async function notifyPackageAcknowledged() {
  await sendTextMessage(":bell: *Package acknowledged*\nButton pressed - entering cooldown period.");
}
