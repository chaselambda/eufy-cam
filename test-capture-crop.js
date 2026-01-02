#!/usr/bin/env node

/**
 * Test script for image cropping, scaling, and text overlay.
 *
 * Usage:
 *   node test-capture-crop.js <input-image.jpg>
 *
 * This will:
 *   1. Crop the image starting at y=1400
 *   2. Downscale by 2x
 *   3. Save as <input>_cropped_scaled.jpg
 *   4. Add a test text overlay to the original
 *   5. Save as <input>_annotated.jpg
 */

import { cropAndScale, addTextOverlay, cleanupTemp } from "./lib/image-processor.js";
import fs from "fs";
import path from "path";

async function main() {
  const inputPath = process.argv[2];

  if (!inputPath) {
    console.error("Usage: node test-capture-crop.js <input-image.jpg>");
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  console.log(`Processing: ${inputPath}`);

  try {
    // Test crop and scale
    console.log("\n1. Cropping and scaling...");
    const croppedPath = await cropAndScale(inputPath);
    console.log(`   Created: ${croppedPath}`);

    // Test text overlay with mock detection result
    console.log("\n2. Adding text overlay...");
    const mockResult = {
      package_detected: true,
      confidence: "high",
      description: "A brown cardboard box approximately 12x8x6 inches is visible on the doorstep near the welcome mat. The package appears to have an Amazon shipping label.",
    };

    const annotatedPath = await addTextOverlay(inputPath, mockResult);
    console.log(`   Created: ${annotatedPath}`);

    // Also test with no package
    console.log("\n3. Testing 'no package' overlay...");
    const mockNoPackage = {
      package_detected: false,
      confidence: "high",
      description: "The doorstep is clear. No packages, boxes, or delivery items are visible.",
    };

    // Compute path in snapshots_annotated folder
    const dir = path.dirname(inputPath);
    const parentDir = path.dirname(dir);
    const annotatedDir = path.join(parentDir, "snapshots_annotated");
    const baseName = path.basename(inputPath, ".jpg");
    const noPackagePath = path.join(annotatedDir, `${baseName}_no_package_annotated.jpg`);

    await addTextOverlay(inputPath, mockNoPackage, noPackagePath);
    console.log(`   Created: ${noPackagePath}`);

    console.log("\nDone! Check the output files.");

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
