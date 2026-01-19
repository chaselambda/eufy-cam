import "dotenv/config";
import { EufySecurity, Device, Camera } from "eufy-security-client";
import fs from "fs";
import { spawn } from "child_process";
import path from "path";

import { logger } from "./lib/logger.js";
import { detectPackage } from "./lib/package-detector.js";
import {
  createClient,
  publishPackageStatus,
  disconnect,
} from "./lib/mqtt-client.js";
import { addTextOverlay } from "./lib/image-processor.js";
import { cleanupOldFiles } from "./lib/utils.js";
import { notifyPackageDetected } from "./lib/slack-notifier.js";

const OUTPUT_ROOT = "./captured";
const SNAPSHOTS_DIR = `${OUTPUT_ROOT}/snapshots`;
const VIDEOS_DIR = `${OUTPUT_ROOT}/videos`;
const COOLDOWN_STATE_FILE = "./data/cooldown-state.json";
const CAPTURE_DURATION_MS = 3000;
const FRAME_CAPTURE_INTERVAL_S = 1;
const DEVICE_DISCOVERY_TIMEOUT_MS = 5000;
const CAPTURE_TIMEOUT_MS = 30000;
const FFMPEG_QUALITY = "2";
const SAVE_RAW_VIDEO = true;
const TARGET_CAMERA_NAME = "775";

// Load Eufy credentials from environment variables
if (!process.env.EUFY_USERNAME) {
  logger.error("EUFY_USERNAME environment variable is not set");
  process.exit(1);
}
if (!process.env.EUFY_PASSWORD) {
  logger.error("EUFY_PASSWORD environment variable is not set");
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
  logging: {
    level: 3, // 0: trace, 1: debug, 2: info, 3: warn, 4: error
  },
};

// Eufy logger that uses our Winston logger
const consoleLogger = {
  trace: (message, ...args) => {}, // Suppress trace
  debug: (message, ...args) => {}, // Suppress debug
  info: (message, ...args) => logger.info(`[EUFY] ${message}`, { args }),
  warn: (message, ...args) => logger.warn(`[EUFY] ${message}`, { args }),
  error: (message, ...args) => logger.error(`[EUFY] ${message}`, { args }),
  fatal: (message, ...args) => logger.error(`[EUFY] ${message}`, { args }),
};

function ensureDirectories() {
  [OUTPUT_ROOT, SNAPSHOTS_DIR, VIDEOS_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

function createFFmpegProcess(codecExt, device, timestamp) {
  const ffmpegArgs = [
    "-f",
    codecExt === "h265" ? "hevc" : "h264",
    "-i",
    "pipe:0",
    "-vf",
    `fps=1/${FRAME_CAPTURE_INTERVAL_S}`,
    "-q:v",
    FFMPEG_QUALITY,
    `${SNAPSHOTS_DIR}/frame_${device.getSerial()}_${timestamp}_%03d.jpg`,
  ];

  const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

  ffmpegProcess.stdout.on("data", (data) => {
    logger.debug("FFmpeg stdout", { data: data.toString() });
  });

  ffmpegProcess.stderr.on("data", (data) => {
    const message = data.toString();
    if (message.includes("frame=")) {
      const frameMatch = message.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        logger.info("Captured frame", { frame: frameMatch[1] });
      }
    }
  });

  ffmpegProcess.on("close", (code) => {
    logger.debug("FFmpeg process exited", { code });
  });

  ffmpegProcess.on("error", (err) => {
    logger.error("FFmpeg process error", { error: err.message });
  });

  return ffmpegProcess;
}

async function handleLivestreamStart(
  station,
  device,
  metadata,
  videoStream,
  audioStream,
  eufy,
  captureState
) {
  logger.info("Livestream started", { device: device.getName() });
  logger.debug("Stream metadata", { metadata });

  const codecExt = metadata.videoCodec === 1 ? "h265" : "h264";
  const timestamp = Date.now();

  try {
    const ffmpegProcess = createFFmpegProcess(codecExt, device, timestamp);
    captureState.ffmpegProcess = ffmpegProcess;

    videoStream.on("data", (chunk) => {
      logger.debug("Received video chunk", { size: chunk.length });
      if (!ffmpegProcess.stdin.destroyed) {
        ffmpegProcess.stdin.write(chunk);
      }
    });

    let writeStream;
    if (SAVE_RAW_VIDEO) {
      const outputPath = `${VIDEOS_DIR}/capture_${device.getSerial()}_${timestamp}.${codecExt}`;
      writeStream = fs.createWriteStream(outputPath);
      videoStream.on("data", (chunk) => {
        writeStream.write(chunk);
      });
    }

    setTimeout(async () => {
      logger.info(
        `Stopping capture after ${CAPTURE_DURATION_MS / 1000} seconds...`
      );

      if (!ffmpegProcess.stdin.destroyed) {
        ffmpegProcess.stdin.end();
      }

      if (writeStream) {
        writeStream.end();
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
      await eufy.stopStationLivestream(device.getSerial());

      logger.info("Capture complete!");
      logger.info(
        `Screenshots saved to: ${SNAPSHOTS_DIR}/frame_${device.getSerial()}_${timestamp}_*.jpg`
      );
      if (SAVE_RAW_VIDEO) {
        logger.info(
          `Raw video saved to: ${VIDEOS_DIR}/capture_${device.getSerial()}_${timestamp}.${codecExt}`
        );
      }

      // Store the frame pattern for package detection
      captureState.framePattern = `${SNAPSHOTS_DIR}/frame_${device.getSerial()}_${timestamp}_`;
      captureState.complete = true;
    }, CAPTURE_DURATION_MS);
  } catch (error) {
    logger.error("Error capturing video:", { error: error.message });
    captureState.complete = true;
  }
}

/**
 * Find the latest captured frame matching a pattern
 * @param {string} pattern - Frame pattern prefix
 * @returns {string|null} - Path to the latest frame or null
 */
function findLatestFrame(pattern) {
  const dir = path.dirname(pattern);
  const prefix = path.basename(pattern);

  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".jpg"));

  if (files.length === 0) {
    return null;
  }

  // Sort by frame number (descending) and return the latest
  files.sort((a, b) => {
    const numA = parseInt(a.match(/_(\d+)\.jpg$/)?.[1] || "0");
    const numB = parseInt(b.match(/_(\d+)\.jpg$/)?.[1] || "0");
    return numB - numA;
  });

  return path.join(dir, files[0]);
}

function findTargetCamera(cameras) {
  for (const camera of cameras) {
    if (camera.getName().toLowerCase().includes(TARGET_CAMERA_NAME)) {
      return camera;
    }
  }
  throw new Error(
    `Target camera "${TARGET_CAMERA_NAME}" not found. Instead found: ${cameras
      .map((c) => c.getName())
      .join(", ")}`
  );
}

async function captureVideo() {
  logger.event("capture_start", "Starting capture process");
  ensureDirectories();

  const eufy = await EufySecurity.initialize(eufyConfig, consoleLogger);
  logger.info("Logging in to Eufy...");

  const captureState = {
    complete: false,
    ffmpegProcess: null,
    framePattern: null,
  };

  eufy.on("device added", (device) => {
    logger.info(`Device found: ${device.getName()} (${device.getSerial()})`);
  });

  eufy.on("station added", (station) => {
    logger.info(`Station found: ${station.getName()} (${station.getSerial()})`);
  });

  eufy.on(
    "station livestream start",
    async (station, device, metadata, videoStream, audioStream) => {
      await handleLivestreamStart(
        station,
        device,
        metadata,
        videoStream,
        audioStream,
        eufy,
        captureState
      );
    }
  );

  await eufy.connect();
  logger.info("Connected successfully!");

  await new Promise((resolve) =>
    setTimeout(resolve, DEVICE_DISCOVERY_TIMEOUT_MS)
  );

  logger.info("Getting devices...");
  const devices = await eufy.getDevices();
  const cameras = devices.filter((device) => device instanceof Camera);

  if (cameras.length === 0) {
    logger.warn("No cameras found!");
    return { packageDetected: false };
  }

  logger.info(`Found ${cameras.length} camera(s):`);
  cameras.forEach((camera, index) => {
    logger.info(`${index + 1}. ${camera.getName()} (${camera.getSerial()})`);
  });

  const targetDevice = findTargetCamera(cameras);
  logger.info(`Using camera: ${targetDevice.getName()}`);

  logger.info("Starting livestream to capture video...");
  await eufy.startStationLivestream(targetDevice.getSerial());

  let timeout = CAPTURE_TIMEOUT_MS;
  const CHECK_INTERVAL_MS = 100;
  while (!captureState.complete && timeout > 0) {
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
    timeout -= CHECK_INTERVAL_MS;
  }

  if (!captureState.complete) {
    logger.error("Capture timeout - stopping livestream");
    await eufy.stopStationLivestream(targetDevice.getSerial());
  }

  logger.info("Cleaning up Eufy connection...");
  eufy.close();

  return captureState;
}

function checkCooldownState() {
  try {
    if (!fs.existsSync(COOLDOWN_STATE_FILE)) {
      logger.warn("Cooldown state file not found, continuing with capture");
      return false;
    }

    const content = fs.readFileSync(COOLDOWN_STATE_FILE, "utf-8");
    const state = JSON.parse(content);

    if (state.inCooldown === true) {
      logger.info("In cooldown period, skipping capture", {
        startedAt: state.startedAt,
      });
      return true;
    }

    return false;
  } catch (error) {
    logger.warn(`Error reading cooldown state: ${error.message}, continuing with capture`);
    return false;
  }
}

async function runOnce() {
  let packageDetected = false;
  let mqttClient = null;

  // Check cooldown state before capture
  if (checkCooldownState()) {
    logger.event("capture_skipped", "Capture skipped due to cooldown");
    return;
  }

  // Clean up old files
  cleanupOldFiles();

  try {
    // Connect to MQTT broker
    mqttClient = await createClient("capture");

    // Capture video and frames
    const captureState = await captureVideo();

    // Find the latest captured frame
    if (captureState.framePattern) {
      const latestFrame = findLatestFrame(captureState.framePattern);

      if (latestFrame) {
        logger.info(`Analyzing latest frame: ${latestFrame}`);

        // Detect packages (cropping handled internally)
        const result = await detectPackage(latestFrame);
        packageDetected = result.package_detected;

        logger.event("package_detection", "Package detection complete", {
          detected: packageDetected,
          confidence: result.confidence,
          description: result.description,
          frame: latestFrame,
        });

        // Add text overlay to original image
        let annotatedPath = null;
        try {
          annotatedPath = await addTextOverlay(latestFrame, result);
          logger.info(`Created annotated image: ${annotatedPath}`);
        } catch (overlayError) {
          logger.warn(`Could not add text overlay: ${overlayError.message}`);
        }

        // Send Slack notification if package detected
        if (packageDetected) {
          const imageToSend = annotatedPath || latestFrame;
          await notifyPackageDetected(imageToSend, result);
        }
      } else {
        logger.warn("No frames captured, cannot detect packages");
      }
    }

    // Publish result to MQTT
    await publishPackageStatus(mqttClient, packageDetected);

    // Log success event for healthcheck
    logger.event("capture_success", "Capture and detection complete", {
      packageDetected,
    });
  } catch (error) {
    logger.error("Error during capture/detection", { error: error.message });
    logger.event("capture_error", "Capture or detection failed", {
      error: error.message,
    });
  } finally {
    // Disconnect from MQTT
    await disconnect(mqttClient);
  }

  logger.info("Video capture completed successfully");
}

/**
 * Parse duration string like "60s", "5m" to milliseconds
 */
function parseDuration(str) {
  const match = str.match(/^(\d+)(s|m|h)?$/);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2] || 's';

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return null;
  }
}

async function main() {
  // Parse --loop argument
  const loopIndex = process.argv.indexOf('--loop');

  if (loopIndex !== -1 && process.argv[loopIndex + 1]) {
    const intervalMs = parseDuration(process.argv[loopIndex + 1]);

    if (!intervalMs) {
      logger.error("Invalid --loop duration. Use format: 60s, 5m, 1h");
      process.exit(1);
    }

    logger.info(`Running in loop mode, interval: ${intervalMs / 1000}s`);

    while (true) {
      await runOnce();
      logger.info(`Waiting ${intervalMs / 1000}s until next capture...`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  } else {
    await runOnce();
    process.exit(0);
  }
}

main();
