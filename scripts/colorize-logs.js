#!/usr/bin/env node

/**
 * Log colorizer for capture.log
 * Reads JSON log lines and outputs colorized version
 *
 * Usage: node scripts/colorize-logs.js [logfile]
 * Default logfile: ./logs/capture.log
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bold: "\x1b[1m",
};

function getLevelColor(level) {
  switch (level?.toLowerCase()) {
    case "error":
      return colors.red;
    case "warn":
      return colors.yellow;
    case "info":
      return colors.green;
    case "debug":
      return colors.blue;
    default:
      return colors.white;
  }
}

function formatLogEntry(entry) {
  try {
    const data = JSON.parse(entry);

    const timestamp = data.timestamp || "";
    const level = (data.level || "INFO").toUpperCase();
    const message = data.message || "";
    const event = data.event || "";
    const runId = data.runId || "";

    const levelColor = getLevelColor(data.level);

    // Build output
    let output = "";

    // Timestamp in gray
    output += `${colors.gray}${timestamp}${colors.reset} `;

    // Level in appropriate color
    output += `${levelColor}${level.padEnd(5)}${colors.reset} `;

    // Run ID in magenta (shortened)
    if (runId) {
      const shortRunId = runId.split("T")[1]?.slice(0, 8) || runId.slice(0, 8);
      output += `${colors.magenta}[${shortRunId}]${colors.reset} `;
    }

    // Event in cyan
    if (event) {
      output += `${colors.cyan}[${event}]${colors.reset} `;
    }

    // Message
    output += message;

    // Additional fields
    const excludeKeys = [
      "timestamp",
      "level",
      "message",
      "event",
      "runId",
      "args",
    ];
    const extra = Object.keys(data)
      .filter((k) => !excludeKeys.includes(k))
      .reduce((acc, k) => {
        acc[k] = data[k];
        return acc;
      }, {});

    if (Object.keys(extra).length > 0) {
      output += ` ${colors.gray}${JSON.stringify(extra)}${colors.reset}`;
    }

    return output;
  } catch {
    // Not valid JSON, return as-is
    return entry;
  }
}

async function processFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      console.log(formatLogEntry(line));
    }
  }
}

async function watchFile(filePath) {
  console.log(
    `${colors.cyan}Watching ${filePath} for changes... (Ctrl+C to stop)${colors.reset}\n`
  );

  // First, output existing content
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        console.log(formatLogEntry(line));
      }
    }
  }

  // Then watch for new content
  let lastSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  fs.watchFile(filePath, { interval: 500 }, (curr, prev) => {
    if (curr.size > lastSize) {
      const stream = fs.createReadStream(filePath, {
        start: lastSize,
        end: curr.size,
      });

      let buffer = "";
      stream.on("data", (chunk) => {
        buffer += chunk.toString();
      });

      stream.on("end", () => {
        const lines = buffer.split("\n");
        for (const line of lines) {
          if (line.trim()) {
            console.log(formatLogEntry(line));
          }
        }
      });

      lastSize = curr.size;
    }
  });
}

// Main
const args = process.argv.slice(2);
const defaultLogFile = path.join(__dirname, "..", "logs", "capture.log");

let filePath = defaultLogFile;
let watchMode = false;

for (const arg of args) {
  if (arg === "-f" || arg === "--follow") {
    watchMode = true;
  } else if (!arg.startsWith("-")) {
    filePath = arg;
  }
}

if (watchMode) {
  watchFile(filePath);
} else {
  processFile(filePath);
}
