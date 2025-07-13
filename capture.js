import { EufySecurity, Device, Camera } from "eufy-security-client";
import fs from "fs";
import { spawn } from "child_process";
import dotenv from "dotenv";
dotenv.config();

const OUTPUT_ROOT = "./captured";
const SNAPSHOTS_DIR = `${OUTPUT_ROOT}/snapshots`;
const VIDEOS_DIR = `${OUTPUT_ROOT}/videos`;
const CAPTURE_DURATION_MS = 3000;
const FRAME_CAPTURE_INTERVAL_S = 1;
const DEVICE_DISCOVERY_TIMEOUT_MS = 5000;
const CAPTURE_TIMEOUT_MS = 30000;
const FFMPEG_QUALITY = "2";
const SAVE_RAW_VIDEO = true;
const TARGET_CAMERA_NAME = "775";

// Load Eufy credentials from environment variables
if (!process.env.EUFY_USERNAME) {
  console.error("Error: EUFY_USERNAME environment variable is not set.");
  process.exit(1);
}
if (!process.env.EUFY_PASSWORD) {
  console.error("Error: EUFY_PASSWORD environment variable is not set.");
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

const consoleLogger = {
  trace: (message, ...args) => console.log("[TRACE]", message, ...args),
  debug: (message, ...args) => console.log("[DEBUG]", message, ...args),
  info: (message, ...args) => console.log("[INFO]", message, ...args),
  warn: (message, ...args) => console.warn("[WARN]", message, ...args),
  error: (message, ...args) => console.error("[ERROR]", message, ...args),
  fatal: (message, ...args) => console.error("[FATAL]", message, ...args),
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
    console.log(`FFmpeg stdout: ${data}`);
  });

  ffmpegProcess.stderr.on("data", (data) => {
    const message = data.toString();
    console.log(`FFmpeg stderr: ${message}`);
    if (message.includes("frame=")) {
      const frameMatch = message.match(/frame=\s*(\d+)/);
      if (frameMatch) {
        console.log(`📸 Captured frame ${frameMatch[1]}`);
      }
    }
  });

  ffmpegProcess.on("close", (code) => {
    console.log(`FFmpeg process exited with code ${code}`);
  });

  ffmpegProcess.on("error", (err) => {
    console.error("FFmpeg process error:", err);
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
  console.log(`Livestream started for ${device.getName()}`);
  console.log("Stream metadata:", metadata);

  const codecExt = metadata.videoCodec === 1 ? "h265" : "h264";
  const timestamp = Date.now();

  try {
    const ffmpegProcess = createFFmpegProcess(codecExt, device, timestamp);
    captureState.ffmpegProcess = ffmpegProcess;

    videoStream.on("data", (chunk) => {
      console.log(`Received video chunk of size: ${chunk.length} bytes`);
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
      console.log(
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

      console.log(`\n✅ Capture complete!`);
      console.log(
        `📸 Screenshots saved to: ${SNAPSHOTS_DIR}/frame_${device.getSerial()}_${timestamp}_*.jpg`
      );
      if (SAVE_RAW_VIDEO) {
        console.log(
          `🎥 Raw video saved to: ${VIDEOS_DIR}/capture_${device.getSerial()}_${timestamp}.${codecExt}`
        );
      }

      captureState.complete = true;
    }, CAPTURE_DURATION_MS);
  } catch (error) {
    console.error("Error capturing video:", error);
    captureState.complete = true;
  }
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
  ensureDirectories();

  const eufy = await EufySecurity.initialize(eufyConfig, consoleLogger);
  console.log("Logging in to Eufy...");

  const captureState = {
    complete: false,
    ffmpegProcess: null,
  };

  eufy.on("device added", (device) => {
    console.log(`Device found: ${device.getName()} (${device.getSerial()})`);
  });

  eufy.on("station added", (station) => {
    console.log(`Station found: ${station.getName()} (${station.getSerial()})`);
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
  console.log("Connected successfully!");

  await new Promise((resolve) =>
    setTimeout(resolve, DEVICE_DISCOVERY_TIMEOUT_MS)
  );

  console.log("Getting devices...");
  const devices = await eufy.getDevices();
  const cameras = devices.filter((device) => device instanceof Camera);

  if (cameras.length === 0) {
    console.log("No cameras found!");
    return;
  }

  console.log(`\nFound ${cameras.length} camera(s):`);
  cameras.forEach((camera, index) => {
    console.log(`${index + 1}. ${camera.getName()} (${camera.getSerial()})`);
  });

  const targetDevice = findTargetCamera(cameras);
  console.log(`\nUsing camera: ${targetDevice.getName()}`);

  console.log("Starting livestream to capture video...");
  await eufy.startStationLivestream(targetDevice.getSerial());

  let timeout = CAPTURE_TIMEOUT_MS;
  const CHECK_INTERVAL_MS = 100;
  while (!captureState.complete && timeout > 0) {
    await new Promise((resolve) => setTimeout(resolve, CHECK_INTERVAL_MS));
    timeout -= CHECK_INTERVAL_MS;
  }

  if (!captureState.complete) {
    console.error("Capture timeout - stopping livestream");
    await eufy.stopStationLivestream(targetDevice.getSerial());
  }

  console.log("\nCleaning up...");
  eufy.close();
}

captureVideo().then(() => {
  console.log("\n✅ Video capture completed successfully.");
  console.log("Check your directory for:");
  console.log(`  - ${VIDEOS_DIR}/capture_*.h264/h265 (raw video)`);
  console.log(`  - ${SNAPSHOTS_DIR}/frame_*.jpg (JPEG images)`);
  process.exit(0);
});
