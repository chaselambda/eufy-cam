import "dotenv/config";
import winston from "winston";

// Show timestamps if LOG_TIMESTAMPS env var is set
const SHOW_TIMESTAMPS = !!process.env.LOG_TIMESTAMPS;

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

    const ts = SHOW_TIMESTAMPS ? `${gray}${timestamp}${reset} ` : "";
    const eventStr = event ? `${cyan}[${event}]${reset} ` : "";
    const lvl = `${levelColor}${level.toUpperCase()}${reset}`;
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";

    return `${ts}${lvl} ${eventStr}${message}${metaStr}`;
  })
);

// Create winston logger (console only)
const baseLogger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

export const logger = {
  info: (message, meta) => baseLogger.info(message, meta),
  warn: (message, meta) => baseLogger.warn(message, meta),
  error: (message, meta) => baseLogger.error(message, meta),
  debug: (message, meta) => baseLogger.debug(message, meta),

  // Convenience method for logging events
  event: (eventName, message, meta = {}) => {
    baseLogger.info(message, { event: eventName, ...meta });
  },
};
