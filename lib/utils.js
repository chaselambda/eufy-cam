import fs from "fs";
import path from "path";
import { logger } from "./logger.js";

const CAPTURED_DIR = "./captured";
const MAX_AGE_DAYS = 7;

/**
 * Delete files older than MAX_AGE_DAYS in the captured directory
 */
export function cleanupOldFiles() {
  const maxAgeMs = MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();
  let deletedCount = 0;

  if (!fs.existsSync(CAPTURED_DIR)) {
    return;
  }

  const subdirs = fs.readdirSync(CAPTURED_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(CAPTURED_DIR, d.name));

  for (const subdir of subdirs) {
    const files = fs.readdirSync(subdir);

    for (const file of files) {
      const filePath = path.join(subdir, file);
      const stats = fs.statSync(filePath);

      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        deletedCount++;
        logger.debug(`Deleted old file: ${filePath}`);
      }
    }
  }

  if (deletedCount > 0) {
    logger.info(`Cleaned up ${deletedCount} files older than ${MAX_AGE_DAYS} days`);
  }
}
