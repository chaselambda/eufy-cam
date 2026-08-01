import fs from "fs";
import path from "path";
import { logger } from "./logger.js";
import { bottomCropPipeline } from "./image-processor.js";

// Change-detector with a cached verdict: we store the doorstep crop of the
// last frame the model actually classified, plus the model's answer for it.
// A new frame that looks the same as that stored frame reuses the answer and
// skips the API call; a changed frame triggers a real classification, which
// then becomes the new reference.

const SMALL_WIDTH = 160;

// Fraction of pixels that must differ (by > PIXEL_DIFF_STDDEVS after
// brightness normalization) to count as a scene change. Tuned on a week of
// labeled frames: looser settings missed small envelopes.
const PIXEL_DIFF_STDDEVS = 0.5;
const CHANGED_FRACTION_THRESHOLD = 0.01;

// Safety valve: force a real classification if the reference is older than
// this, so any stuck state self-corrects.
const MAX_REFERENCE_AGE_MS = 60 * 60 * 1000;

// Single JSON file (verdict + pixels together) so a torn write cannot pair
// one frame's pixels with another frame's verdict: a truncated file fails
// JSON.parse and fails open into a real model call.
const DATA_DIR = "./data";
const REFERENCE_FILE = path.join(DATA_DIR, "prefilter-reference.json");

/**
 * Decode the frame, crop to the bottom-camera view, shrink to a small
 * grayscale image, and normalize brightness/contrast.
 * @param {string} imagePath
 * @returns {Promise<{pixels: Float32Array, width: number, height: number}>}
 */
async function loadNormalizedCrop(imagePath) {
  const pipeline = await bottomCropPipeline(imagePath);
  const { data, info } = await pipeline
    .resize({ width: SMALL_WIDTH })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / data.length;
  let sqSum = 0;
  for (const v of data) sqSum += (v - mean) * (v - mean);
  // Floor the contrast so a washed-out frame (fog, IR washout) doesn't
  // amplify sensor noise past the change threshold and defeat all caching
  const std = Math.max(Math.sqrt(sqSum / data.length), 8);

  const pixels = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) {
    pixels[i] = (data[i] - mean) / std;
  }
  return { pixels, width: info.width, height: info.height };
}

/**
 * Compare the frame against the stored reference.
 * Fails open: any error, missing reference, or stale reference means
 * "changed" so the model gets called.
 * @param {string} imagePath
 * @returns {Promise<{changed: boolean, score: number|null, reason: string,
 *                    cachedResult: object|null, crop: object|null}>}
 */
export async function checkChange(imagePath) {
  try {
    if (!fs.existsSync(REFERENCE_FILE)) {
      return { changed: true, score: null, reason: "no_reference", cachedResult: null, crop: null };
    }

    const meta = JSON.parse(fs.readFileSync(REFERENCE_FILE, "utf8"));
    const ageMs = Date.now() - new Date(meta.timestamp).getTime();
    // A future timestamp (clock stepped backward) must count as stale too
    if (!(ageMs >= 0 && ageMs < MAX_REFERENCE_AGE_MS)) {
      return { changed: true, score: null, reason: "reference_stale", cachedResult: null, crop: null };
    }

    const current = await loadNormalizedCrop(imagePath);
    if (current.width !== meta.width || current.height !== meta.height) {
      return { changed: true, score: null, reason: "dimension_mismatch", cachedResult: null, crop: current };
    }

    const refBuffer = Buffer.from(meta.pixels, "base64");
    if (refBuffer.byteLength !== current.pixels.length * Float32Array.BYTES_PER_ELEMENT) {
      return { changed: true, score: null, reason: "size_mismatch", cachedResult: null, crop: current };
    }
    const refPixels = new Float32Array(
      refBuffer.buffer,
      refBuffer.byteOffset,
      current.pixels.length
    );

    let changedPixels = 0;
    for (let i = 0; i < current.pixels.length; i++) {
      if (Math.abs(current.pixels[i] - refPixels[i]) > PIXEL_DIFF_STDDEVS) {
        changedPixels++;
      }
    }
    const score = changedPixels / current.pixels.length;

    if (score > CHANGED_FRACTION_THRESHOLD) {
      return { changed: true, score, reason: "scene_changed", cachedResult: null, crop: current };
    }
    return { changed: false, score, reason: "unchanged", cachedResult: meta.result, crop: current };
  } catch (error) {
    logger.warn(`Pre-filter check failed, calling model: ${error.message}`);
    return { changed: true, score: null, reason: "prefilter_error", cachedResult: null, crop: null };
  }
}

/**
 * Store this frame's crop and the model's verdict as the new reference.
 * Failures are logged but not thrown: a lost reference only costs an extra
 * model call next frame.
 * @param {string} imagePath
 * @param {object} result - verdict from detectPackage()
 * @param {object|null} crop - crop already loaded by checkChange(), to skip re-decoding
 */
export async function saveReference(imagePath, result, crop = null) {
  try {
    const { pixels, width, height } = crop || (await loadNormalizedCrop(imagePath));
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      REFERENCE_FILE,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        width,
        height,
        result,
        pixels: Buffer.from(pixels.buffer).toString("base64"),
      })
    );
  } catch (error) {
    logger.warn(`Could not save pre-filter reference: ${error.message}`);
  }
}
