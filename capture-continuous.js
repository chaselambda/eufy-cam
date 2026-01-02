#!/usr/bin/env node

/**
 * Continuous video capture from Eufy camera.
 * Saves a screenshot every 1 second until stopped (Ctrl+C).
 *
 * Usage:
 *   node capture-continuous.js
 */

import "dotenv/config";
import { EufySecurity, Camera } from "eufy-security-client";
import fs from "fs";
import { spawn } from "child_process";
import path from "path";

import { logger, RUN_ID } from "./lib/logger.js";

const OUTPUT_ROOT = "./captured";
const SNAPSHOTS_DIR = `${OUTPUT_ROOT}/snapshots`;
const FRAME_INTERVAL_S = 5;
const DEVICE_DISCOVERY_TIMEOUT_MS = 5000;
const TARGET_CAMERA_NAME = "775";

if (!process.env.EUFY_USERNAME || !process.env.EUFY_PASSWORD) {
  console.error("Error: EUFY_USERNAME and EUFY_PASSWORD must be set in .env");
  process.exit(1);
}

const eufyConfig = {
  username: process.env.EUFY_USERNAME,
  password: process.env.EUFY_PASSWORD,
  country: "US",
  language: "en",
  persistentDir: "./data",
  p2pConnectionSetup: 2,
  pollingIntervalMinutes: 10,
  eventDurationSeconds: 10,
  logging: { level: 3 },
};

const consoleLogger = {
  trace: () => {},
  debug: () => {},
  info: (message, ...args) => logger.info(`[EUFY] ${message}`, { args }),
  warn: (message, ...args) => logger.warn(`[EUFY] ${message}`, { args }),
  error: (message, ...args) => logger.error(`[EUFY] ${message}`, { args }),
  fatal: (message, ...args) => logger.error(`[EUFY] ${message}`, { args }),
};

function ensureDirectories() {
  [OUTPUT_ROOT, SNAPSHOTS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

let ffmpegProcess = null;
let eufy = null;
let frameCount = 0;

function createFFmpegProcess(codecExt, device) {
  const timestamp = Date.now();
  const outputPattern = `${SNAPSHOTS_DIR}/frame_${device.getSerial()}_${timestamp}_%06d.jpg`;

  const ffmpegArgs = [
    "-f", codecExt === "h265" ? "hevc" : "h264",
    "-i", "pipe:0",
    "-vf", `fps=1/${FRAME_INTERVAL_S}`,
    "-q:v", "2",
    "-update", "0",
    outputPattern,
  ];

  const proc = spawn("ffmpeg", ffmpegArgs);

  proc.stderr.on("data", (data) => {
    const message = data.toString();
    if (message.includes("frame=")) {
      const frameMatch = message.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        frameCount = parseInt(frameMatch[1]);
        process.stdout.write(`\rFrames captured: ${frameCount}`);
      }
    }
  });

  proc.on("close", (code) => {
    logger.info(`FFmpeg exited with code ${code}`);
  });

  proc.on("error", (err) => {
    logger.error("FFmpeg error", { error: err.message });
  });

  logger.info(`Saving frames to: ${outputPattern}`);

  return proc;
}

async function handleLivestreamStart(station, device, metadata, videoStream, audioStream) {
  console.log(`\nLivestream started for ${device.getName()}`);
  console.log("Stream metadata:", metadata);

  const codecExt = metadata.videoCodec === 1 ? "h265" : "h264";
  ffmpegProcess = createFFmpegProcess(codecExt, device);

  videoStream.on("data", (chunk) => {
    if (ffmpegProcess && !ffmpegProcess.stdin.destroyed) {
      ffmpegProcess.stdin.write(chunk);
    }
  });

  console.log("\nCapturing frames continuously. Press Ctrl+C to stop.\n");
}

function findTargetCamera(cameras) {
  for (const camera of cameras) {
    if (camera.getName().toLowerCase().includes(TARGET_CAMERA_NAME)) {
      return camera;
    }
  }
  throw new Error(
    `Target camera "${TARGET_CAMERA_NAME}" not found. Found: ${cameras.map((c) => c.getName()).join(", ")}`
  );
}

async function shutdown(targetSerial) {
  console.log("\n\nShutting down...");

  if (ffmpegProcess && !ffmpegProcess.stdin.destroyed) {
    ffmpegProcess.stdin.end();
  }

  if (eufy && targetSerial) {
    try {
      await eufy.stopStationLivestream(targetSerial);
      logger.info("Stopped livestream");
    } catch (e) {
      // Ignore errors during shutdown
    }
  }

  if (eufy) {
    eufy.close();
  }

  console.log(`\nTotal frames captured: ${frameCount}`);
  console.log(`Frames saved to: ${SNAPSHOTS_DIR}/`);
  process.exit(0);
}

async function main() {
  logger.info("Starting continuous capture", { runId: RUN_ID });
  ensureDirectories();

  eufy = await EufySecurity.initialize(eufyConfig, consoleLogger);
  logger.info("Logging in to Eufy...");

  let targetSerial = null;

  eufy.on("device added", (device) => {
    logger.info(`Device found: ${device.getName()} (${device.getSerial()})`);
  });

  eufy.on("station livestream start", async (station, device, metadata, videoStream, audioStream) => {
    await handleLivestreamStart(station, device, metadata, videoStream, audioStream);
  });

  eufy.on("station livestream stop", () => {
    logger.warn("Livestream stopped unexpectedly");
  });

  // Handle Ctrl+C
  process.on("SIGINT", () => shutdown(targetSerial));
  process.on("SIGTERM", () => shutdown(targetSerial));

  await eufy.connect();
  logger.info("Connected successfully!");

  await new Promise((resolve) => setTimeout(resolve, DEVICE_DISCOVERY_TIMEOUT_MS));

  const devices = await eufy.getDevices();
  const cameras = devices.filter((device) => device instanceof Camera);

  if (cameras.length === 0) {
    logger.error("No cameras found!");
    process.exit(1);
  }

  const targetDevice = findTargetCamera(cameras);
  targetSerial = targetDevice.getSerial();
  logger.info(`Using camera: ${targetDevice.getName()}`);

  logger.info("Starting continuous livestream...");
  await eufy.startStationLivestream(targetSerial);

  // Keep running until Ctrl+C
  await new Promise(() => {});
}

main().catch((err) => {
  logger.error("Fatal error", { error: err.message });
  process.exit(1);
});
