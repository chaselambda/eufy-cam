import winston from "winston";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create logs directory if it doesn't exist
const LOGS_DIR = path.join(__dirname, "..", "logs");
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

const CAPTURE_LOG = path.join(LOGS_DIR, "capture.log");

// Run ID is the timestamp when the process started
export const RUN_ID = new Date().toISOString();

// Custom format for console output (colorized)
const consoleFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(({ level, message, timestamp, event, ...meta }) => {
    const gray = "\x1b[90m";
    const cyan = "\x1b[36m";
    const reset = "\x1b[0m";
    const yellow = "\x1b[33m";
    const red = "\x1b[31m";
    const green = "\x1b[32m";

    let levelColor = reset;
    switch (level) {
      case "error":
        levelColor = red;
        break;
      case "warn":
        levelColor = yellow;
        break;
      case "info":
        levelColor = green;
        break;
      default:
        levelColor = reset;
    }

    const ts = `${gray}${timestamp}${reset}`;
    const eventStr = event ? `${cyan}[${event}]${reset} ` : "";
    const lvl = `${levelColor}${level.toUpperCase()}${reset}`;
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";

    return `${ts} ${lvl} ${eventStr}${message}${metaStr}`;
  })
);

// Custom format for file output (JSON lines)
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Create base winston logger
const baseLogger = winston.createLogger({
  level: "info",
  transports: [
    // Console transport with colorized output
    new winston.transports.Console({
      format: consoleFormat,
    }),
    // File transport with JSON format
    new winston.transports.File({
      filename: CAPTURE_LOG,
      format: fileFormat,
    }),
  ],
});

// Wrapper that adds runId to all log entries
function createLoggerWithRunId() {
  const addRunId = (level, message, meta = {}) => {
    baseLogger.log({
      level,
      message,
      runId: RUN_ID,
      ...meta,
    });
  };

  return {
    info: (message, meta) => addRunId("info", message, meta),
    warn: (message, meta) => addRunId("warn", message, meta),
    error: (message, meta) => addRunId("error", message, meta),
    debug: (message, meta) => addRunId("debug", message, meta),

    // Convenience method for logging events
    event: (eventName, message, meta = {}) => {
      addRunId("info", message, { event: eventName, ...meta });
    },
  };
}

export const logger = createLoggerWithRunId();

// Export the log file path for healthcheck
export const LOG_FILE_PATH = CAPTURE_LOG;
