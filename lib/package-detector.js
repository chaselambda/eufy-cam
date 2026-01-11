import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import { cropAndScale, cleanupTemp } from "./image-processor.js";

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
 * @returns {Promise<{package_detected: boolean, confidence: string, description: string}>}
 */
export async function detectPackage(imagePath) {
  if (!fs.existsSync(imagePath)) {
    logger.error("Image not found", { path: imagePath });
    throw new Error(`Image not found at ${imagePath}`);
  }

  logger.info("Starting package detection", { image: imagePath });

  // Crop and scale image for API call
  let processedPath = imagePath;
  let shouldCleanup = false;

  try {
    processedPath = await cropAndScale(imagePath);
    shouldCleanup = true;
    logger.info("Cropped and scaled image", { processedPath });
  } catch (e) {
    logger.warn(`Could not crop image, using original: ${e.message}`);
  }

  const image = imageToBase64(processedPath);

  const prompt = `
  Determine if there's a package on the doorstep in the provided image and no human exists. The package needs to be obvious. I.e. if there's some dark object that might be a package or might be a shadow and it's not clear, the answer should be no.
  
  The camera will be facing down, so you may just see the legs of a person. If a person is there (i.e. their legs), return false because the package is not left unattended.

  First, respond with a description of the image, without consideration for packages. Just simply describe what you see in the image. Then, respond with true/false for if there is a package and no human present. Respond with ONLY valid JSON (no markdown, no explanation). Here's an example response:
{"description": "Brief description", "package_detected": true}`;

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Calling Anthropic API (attempt ${attempt}/${MAX_RETRIES})`);

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
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

      // Clean up temp file
      if (shouldCleanup) {
        cleanupTemp(processedPath);
      }

      return {
        package_detected: parsed.package_detected === true,
        confidence: parsed.confidence || "unknown",
        description: parsed.description || "",
      };
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
