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
import { detectPackage } from "../lib/package-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RUNS_PER_IMAGE = 3;
const MAX_REQUESTS_PER_SECOND = 10;
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
