#!/usr/bin/env node

/**
 * Evaluate package detection accuracy.
 *
 * Reads images from:
 *   - package-detection-eval/no-package/     (expected: package_detected = false)
 *   - package-detection-eval/package-exists/ (expected: package_detected = true)
 *
 * Runs each image through the API in parallel (max 10/sec) and scores accuracy.
 *
 * Usage:
 *   node package-detection-eval/run-eval.js
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { detectPackage, countDetectionTokens } from "../lib/package-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RUNS_PER_IMAGE = 3;
const MAX_REQUESTS_PER_SECOND = 10;
const TOKEN_SAMPLE_SIZE = 8;
const TARGET_WIDTH = Number(process.env.DETECT_TARGET_WIDTH) || 480;
// gemini-3.1-flash-lite input rate, and the production model-call volume
// measured on the server. Captures run every 180s, but the pixel-diff
// pre-filter answers ~98% of them from the previous verdict without touching
// the API (measured: 2 model calls across 107 cycles in two clean windows), so
// costing this at one call per capture overstates the bill by ~50x.
const INPUT_COST_PER_MTOK = 0.25;
const CAPTURES_PER_MONTH = (30.4 * 24 * 60 * 60) / 180;
const PRE_FILTER_PASS_RATE = 0.02;
const CALLS_PER_MONTH = CAPTURES_PER_MONTH * PRE_FILTER_PASS_RATE;
const NO_PACKAGE_DIR = path.join(__dirname, "no-package");
const PACKAGE_EXISTS_DIR = path.join(__dirname, "package-exists");

function getImageFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir)
    .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
    .map(f => path.join(dir, f));
}

/**
 * Rate-limited parallel execution
 */
async function runWithRateLimit(tasks, maxPerSecond) {
  const results = [];
  const interval = 1000 / maxPerSecond;
  let completed = 0;

  const runTask = async (task, index) => {
    // Stagger start times
    await new Promise(resolve => setTimeout(resolve, index * interval));

    const result = await task();
    completed++;
    process.stdout.write(`\rProgress: ${completed}/${tasks.length}`);
    return result;
  };

  const promises = tasks.map((task, index) => runTask(task, index));
  const allResults = await Promise.all(promises);

  console.log(); // newline after progress
  return allResults;
}

function monthlyInputCost(promptTokens) {
  return (promptTokens * CALLS_PER_MONTH * INPUT_COST_PER_MTOK) / 1_000_000;
}

/**
 * Measure real prompt-token cost for a sample of images at the current width.
 * @param {string[]} imagePaths
 */
async function measurePromptTokens(imagePaths) {
  if (imagePaths.length === 0) return null;

  const counts = [];
  let dims = "unknown";

  for (const imagePath of imagePaths) {
    try {
      const { promptTokens, width, height } = await countDetectionTokens(imagePath);
      counts.push(promptTokens);
      dims = `${width}x${height}`;
    } catch (error) {
      console.log(`\nToken measurement skipped for ${path.basename(imagePath)}: ${error.message}`);
    }
  }

  if (counts.length === 0) return null;

  return {
    dims,
    n: counts.length,
    mean: counts.reduce((a, b) => a + b, 0) / counts.length,
    min: Math.min(...counts),
    max: Math.max(...counts),
  };
}

async function evaluateSingle(imagePath, expected) {
  const fileName = path.basename(imagePath);

  try {
    const result = await detectPackage(imagePath);
    return {
      image: fileName,
      expected,
      detected: result.package_detected,
      confidence: result.confidence,
      description: result.description,
      error: null,
    };
  } catch (error) {
    return {
      image: fileName,
      expected,
      detected: null,
      confidence: null,
      description: null,
      error: error.message,
    };
  }
}

function formatPercent(count, total) {
  if (total === 0) return "0% (0/0)";
  const pct = (count / total * 100).toFixed(1);
  return `${pct}% (${count}/${total})`;
}

async function main() {
  console.log("Package Detection Evaluation\n");
  console.log("=".repeat(60));

  const noPackageImages = getImageFiles(NO_PACKAGE_DIR);
  const packageExistsImages = getImageFiles(PACKAGE_EXISTS_DIR);

  console.log(`\nFound ${noPackageImages.length} no-package images`);
  console.log(`Found ${packageExistsImages.length} package-exists images`);

  const totalImages = noPackageImages.length + packageExistsImages.length;
  const totalRuns = totalImages * RUNS_PER_IMAGE;
  console.log(`Total runs: ${totalRuns}\n`);

  if (totalImages === 0) {
    console.log("No images found. Add images to:");
    console.log(`  ${NO_PACKAGE_DIR}`);
    console.log(`  ${PACKAGE_EXISTS_DIR}`);
    process.exit(1);
  }

  // Build task list
  const tasks = [];

  for (const imagePath of noPackageImages) {
    for (let run = 0; run < RUNS_PER_IMAGE; run++) {
      tasks.push(() => evaluateSingle(imagePath, false));
    }
  }

  for (const imagePath of packageExistsImages) {
    for (let run = 0; run < RUNS_PER_IMAGE; run++) {
      tasks.push(() => evaluateSingle(imagePath, true));
    }
  }

  // Measure what one detection call actually costs at the current crop width
  // before spending money on the accuracy runs. countTokens is free, so this
  // is the cheap half of deciding whether a narrower crop is worth it.
  const tokenStats = await measurePromptTokens(
    [...noPackageImages, ...packageExistsImages].slice(0, TOKEN_SAMPLE_SIZE)
  );

  console.log("Running evaluations...");
  const results = await runWithRateLimit(tasks, MAX_REQUESTS_PER_SECOND);

  // Compute confusion matrix
  let truePositive = 0;   // expected=true, detected=true
  let trueNegative = 0;   // expected=false, detected=false
  let falsePositive = 0;  // expected=false, detected=true
  let falseNegative = 0;  // expected=true, detected=false
  const failures = [];

  for (const r of results) {
    if (r.error) {
      failures.push(r);
      continue;
    }

    if (r.expected === true && r.detected === true) {
      truePositive++;
    } else if (r.expected === false && r.detected === false) {
      trueNegative++;
    } else if (r.expected === false && r.detected === true) {
      falsePositive++;
      failures.push(r);
    } else if (r.expected === true && r.detected === false) {
      falseNegative++;
      failures.push(r);
    }
  }

  const totalPositive = truePositive + falseNegative; // actual positives
  const totalNegative = trueNegative + falsePositive; // actual negatives
  const totalValid = truePositive + trueNegative + falsePositive + falseNegative;

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("CONFUSION MATRIX");
  console.log("=".repeat(60));
  console.log(`\nTrue Positive:  ${formatPercent(truePositive, totalPositive)}`);
  console.log(`False Negative: ${formatPercent(falseNegative, totalPositive)}`);
  console.log(`True Negative:  ${formatPercent(trueNegative, totalNegative)}`);
  console.log(`False Positive: ${formatPercent(falsePositive, totalNegative)}`);

  const accuracy = totalValid > 0 ? (truePositive + trueNegative) / totalValid * 100 : 0;
  console.log(`\nOverall Accuracy: ${accuracy.toFixed(1)}%`);

  if (tokenStats) {
    console.log("\n" + "=".repeat(60));
    console.log("INPUT COST");
    console.log("=".repeat(60));
    console.log(`\nCrop width:        ${TARGET_WIDTH}px`);
    console.log(`Image sent:        ${tokenStats.dims}`);
    console.log(`Prompt tokens:     ${tokenStats.mean.toFixed(0)} (min ${tokenStats.min}, max ${tokenStats.max}, n=${tokenStats.n})`);
    console.log(`Monthly input:     $${monthlyInputCost(tokenStats.mean).toFixed(2)} at ~${Math.round(CALLS_PER_MONTH).toLocaleString()} model calls/mo`);
    console.log(`                   (${Math.round(CAPTURES_PER_MONTH).toLocaleString()} captures/mo, ${(PRE_FILTER_PASS_RATE * 100).toFixed(0)}% reach the model)`);
  }

  if (failures.length > 0) {
    console.log(`\n${"=".repeat(60)}`);
    console.log("FAILURES");
    console.log("=".repeat(60));

    for (const f of failures) {
      console.log(`\n${f.image}:`);
      console.log(`  Expected: ${f.expected}`);
      console.log(`  Got: ${f.detected}`);
      if (f.confidence) console.log(`  Confidence: ${f.confidence}`);
      if (f.description) console.log(`  Description: ${f.description}`);
      if (f.error) console.log(`  Error: ${f.error}`);
    }
  }

  console.log("\n");
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
