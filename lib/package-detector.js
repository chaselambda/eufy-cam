import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REFERENCE_IMAGE_PATH = path.join(
  __dirname,
  "..",
  "reference",
  "doorstep-reference.jpg"
);

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
 * Detect packages in an image by comparing to reference image
 * @param {string} currentImagePath - Path to the current captured frame
 * @returns {Promise<boolean>} - True if package detected
 */
export async function detectPackage(currentImagePath) {
  // Check if reference image exists
  if (!fs.existsSync(REFERENCE_IMAGE_PATH)) {
    logger.error("Reference image not found", { path: REFERENCE_IMAGE_PATH });
    throw new Error(
      `Reference image not found at ${REFERENCE_IMAGE_PATH}. Please place a reference image of your empty doorstep.`
    );
  }

  // Check if current image exists
  if (!fs.existsSync(currentImagePath)) {
    logger.error("Current image not found", { path: currentImagePath });
    throw new Error(`Current image not found at ${currentImagePath}`);
  }

  logger.info("Starting package detection", {
    currentImage: currentImagePath,
    referenceImage: REFERENCE_IMAGE_PATH,
  });

  // Load images
  const referenceImage = imageToBase64(REFERENCE_IMAGE_PATH);
  const currentImage = imageToBase64(currentImagePath);

  const prompt = `You are analyzing two images of a doorstep/entrance area.

IMAGE 1 (Reference): Shows the normal state of the doorstep when empty. IGNORE: street, sidewalk, stoop, permanent fixtures, plants, decorations.

IMAGE 2 (Current): Current capture from the camera.

TASK: Compare the two images carefully. Look specifically for packages, boxes, envelopes, or delivery items that appear in the current image (Image 2) but NOT in the reference image (Image 1).

Important guidelines:
- Focus on the immediate doorstep/entrance area
- Ignore changes in lighting, shadows, weather
- Ignore people, vehicles, or animals
- Ignore the street, sidewalk, and areas beyond the immediate entrance
- Only detect items that look like delivered packages (boxes, padded envelopes, shipping bags)

Respond with ONLY valid JSON (no markdown, no explanation):
{"package_detected": true/false, "confidence": "high/medium/low", "description": "Brief description of what you see or why no package was detected"}`;

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
                  media_type: referenceImage.mediaType,
                  data: referenceImage.base64,
                },
              },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: currentImage.mediaType,
                  data: currentImage.base64,
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
