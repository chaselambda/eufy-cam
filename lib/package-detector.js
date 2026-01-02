import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Initialize Anthropic client
const anthropic = new Anthropic();

/**
 * Convert image file to base64 data URL
 * @param {string} imagePath - Path to image file
 * @returns {{base64: string, mediaType: string}}
 */
function imageToBase64(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString("base64");

  // Determine media type from extension
  const ext = path.extname(imagePath).toLowerCase();
  let mediaType = "image/jpeg";
  if (ext === ".png") {
    mediaType = "image/png";
  } else if (ext === ".gif") {
    mediaType = "image/gif";
  } else if (ext === ".webp") {
    mediaType = "image/webp";
  }

  return { base64, mediaType };
}

/**
 * Parse JSON response from Claude, handling potential formatting issues
 * @param {string} text - Response text from Claude
 * @returns {object|null}
 */
function parseJsonResponse(text) {
  // Try direct parse first
  try {
    return JSON.parse(text.trim());
  } catch {
    // Look for JSON object in the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Detect packages in an image
 * @param {string} imagePath - Path to the captured frame
 * @returns {Promise<boolean>} - True if package detected
 */
export async function detectPackage(imagePath) {
  if (!fs.existsSync(imagePath)) {
    logger.error("Image not found", { path: imagePath });
    throw new Error(`Image not found at ${imagePath}`);
  }

  logger.info("Starting package detection", { image: imagePath });

  const image = imageToBase64(imagePath);

  const prompt = `Is there a package on this doorstep?

Respond with ONLY valid JSON (no markdown, no explanation):
{"package_detected": true/false, "confidence": "high/medium/low", "description": "Brief description"}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Calling Anthropic API (attempt ${attempt}/${MAX_RETRIES})`);

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: image.mediaType,
                  data: image.base64,
                },
              },
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      });

      const responseText =
        response.content[0].type === "text" ? response.content[0].text : "";

      logger.info("Received response from Anthropic", {
        rawResponse: responseText,
      });

      const parsed = parseJsonResponse(responseText);

      if (!parsed) {
        throw new Error(`Failed to parse JSON response: ${responseText}`);
      }

      logger.info("Package detection result", {
        detected: parsed.package_detected,
        confidence: parsed.confidence,
        description: parsed.description,
      });

      return parsed.package_detected === true;
    } catch (error) {
      lastError = error;
      logger.warn(`Attempt ${attempt} failed`, { error: error.message });

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * attempt; // Exponential backoff
        logger.info(`Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error("All retry attempts failed", { error: lastError?.message });
  throw lastError || new Error("Package detection failed after all retries");
}
