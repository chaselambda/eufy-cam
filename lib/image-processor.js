import sharp from "sharp";
import path from "path";
import fs from "fs";

const CROP_START_Y = 1400;
const SCALE_FACTOR = 2;
const TEXT_PADDING = 20;
const LINE_HEIGHT = 40;
const MAX_CHARS_PER_LINE = 60;

/**
 * Crop image starting at CROP_START_Y and downscale by SCALE_FACTOR
 * @param {string} inputPath - Path to original image
 * @returns {Promise<string>} - Path to processed temp file
 */
export async function cropAndScale(inputPath) {
  const metadata = await sharp(inputPath).metadata();
  const cropHeight = metadata.height - CROP_START_Y;

  if (cropHeight <= 0) {
    throw new Error(`Image height (${metadata.height}) is less than crop start (${CROP_START_Y})`);
  }

  const tempPath = inputPath.replace(/\.jpg$/, "_cropped_scaled.jpg");

  await sharp(inputPath)
    .extract({
      left: 0,
      top: CROP_START_Y,
      width: metadata.width,
      height: cropHeight,
    })
    .resize({
      width: Math.round(metadata.width / SCALE_FACTOR),
      height: Math.round(cropHeight / SCALE_FACTOR),
    })
    .toFile(tempPath);

  return tempPath;
}

/**
 * Wrap text to fit within maxChars per line
 * @param {string} text
 * @param {number} maxChars
 * @returns {string[]}
 */
function wrapText(text, maxChars = MAX_CHARS_PER_LINE) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";

  for (const word of words) {
    if ((currentLine + " " + word).trim().length <= maxChars) {
      currentLine = (currentLine + " " + word).trim();
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines;
}

/**
 * Add detection result text overlay to the top of the original image
 * @param {string} inputPath - Path to original image
 * @param {object} result - Detection result {package_detected, confidence, description}
 * @param {string} outputPath - Path for output image (optional, defaults to snapshots_annotated folder)
 * @returns {Promise<string>} - Path to annotated image
 */
export async function addTextOverlay(inputPath, result, outputPath = null) {
  const metadata = await sharp(inputPath).metadata();

  if (!outputPath) {
    // Save to sibling snapshots_annotated folder
    const dir = path.dirname(inputPath);
    const parentDir = path.dirname(dir);
    const annotatedDir = path.join(parentDir, "snapshots_annotated");

    if (!fs.existsSync(annotatedDir)) {
      fs.mkdirSync(annotatedDir, { recursive: true });
    }

    const baseName = path.basename(inputPath, ".jpg");
    outputPath = path.join(annotatedDir, `${baseName}_annotated.jpg`);
  }

  const decision = result.package_detected ? "PACKAGE DETECTED" : "NO PACKAGE";
  const decisionColor = result.package_detected ? "#00FF00" : "#FF6600";
  const confidence = `(${result.confidence} confidence)`;
  const descriptionLines = wrapText(result.description || "");

  // Build SVG overlay
  let y = TEXT_PADDING + LINE_HEIGHT;
  let svgText = `
    <text x="${TEXT_PADDING}" y="${y}" font-size="36" font-weight="bold" fill="${decisionColor}" font-family="Arial, sans-serif">${decision}</text>
  `;
  y += LINE_HEIGHT;

  svgText += `
    <text x="${TEXT_PADDING}" y="${y}" font-size="24" fill="#FFFFFF" font-family="Arial, sans-serif">${confidence}</text>
  `;
  y += LINE_HEIGHT;

  for (const line of descriptionLines) {
    svgText += `
      <text x="${TEXT_PADDING}" y="${y}" font-size="24" fill="#CCCCCC" font-family="Arial, sans-serif">${escapeXml(line)}</text>
    `;
    y += LINE_HEIGHT - 5;
  }

  const svgOverlay = `
    <svg width="${metadata.width}" height="${CROP_START_Y}">
      <rect x="0" y="0" width="${metadata.width}" height="${CROP_START_Y}" fill="rgba(0,0,0,0.7)"/>
      ${svgText}
    </svg>
  `;

  await sharp(inputPath)
    .composite([
      {
        input: Buffer.from(svgOverlay),
        top: 0,
        left: 0,
      },
    ])
    .toFile(outputPath);

  return outputPath;
}

/**
 * Escape special XML characters
 */
function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Clean up temporary cropped/scaled file
 * @param {string} tempPath
 */
export function cleanupTemp(tempPath) {
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }
}
