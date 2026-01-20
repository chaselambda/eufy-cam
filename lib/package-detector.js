import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import { cropAndScale, cleanupTemp } from "./image-processor.js";

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// Model selection from environment
const MODEL_PROVIDER = process.env.MODEL || "claude";

// Initialize clients
const anthropic = new Anthropic();
const genAI = process.env.GOOGLE_AI_API_KEY
  ? new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY)
  : null;

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
 * Parse JSON response, handling potential formatting issues
 * @param {string} text - Response text from model
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

const DETECTION_PROMPT = `
Determine if there's a package on the doorstep in the provided image and no human exists. The package needs to be obvious. I.e. if there's some dark object that might be a package or might be a shadow and it's not clear, the answer should be no.

The camera will be facing down, so you may just see the legs of a person. If a person is there (i.e. their legs), return false because the package is not left unattended.

First, respond with a description of the image, without consideration for packages. Just simply describe what you see in the image. Then, respond with true/false for if there is a package and no human present. Respond with ONLY valid JSON (no markdown, no explanation). Here's an example response:
{"description": "Brief description", "package_detected": true}`;

/**
 * Detect packages using Claude API
 * @param {{base64: string, mediaType: string}} image
 * @returns {Promise<string>}
 */
async function detectWithClaude(image) {
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
            text: DETECTION_PROMPT,
          },
        ],
      },
    ],
  });

  return response.content[0].type === "text" ? response.content[0].text : "";
}

/**
 * Detect packages using Gemini API
 * @param {{base64: string, mediaType: string}} image
 * @returns {Promise<string>}
 */
async function detectWithGemini(image) {
  if (!genAI) {
    throw new Error("GOOGLE_AI_API_KEY is not configured");
  }

  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite-preview-09-2025" });

  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: image.mediaType,
        data: image.base64,
      },
    },
    { text: DETECTION_PROMPT },
  ]);

  return result.response.text();
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
  const provider = MODEL_PROVIDER.toLowerCase();

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(
        `Calling ${provider === "gemini" ? "Gemini" : "Anthropic"} API (attempt ${attempt}/${MAX_RETRIES})`
      );

      const responseText =
        provider === "gemini"
          ? await detectWithGemini(image)
          : await detectWithClaude(image);

      logger.info(`Received response from ${provider === "gemini" ? "Gemini" : "Anthropic"}`, {
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
