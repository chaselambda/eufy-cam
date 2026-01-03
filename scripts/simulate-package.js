#!/usr/bin/env node

/**
 * Simulate package detection by publishing an MQTT message.
 *
 * Usage:
 *   node scripts/simulate-package.js           # Package detected (exists: true)
 *   node scripts/simulate-package.js true      # Package detected (exists: true)
 *   node scripts/simulate-package.js false     # Package removed (exists: false)
 */

import {
  createClient,
  publishPackageStatus,
  disconnect,
} from "../lib/mqtt-client.js";

// Parse command-line argument (default to true if not provided)
const arg = process.argv[2];
const packageExists = arg === undefined || arg.toLowerCase() !== "false";

console.log(`Simulating package detection: exists=${packageExists}`);

const client = await createClient("simulate");
await publishPackageStatus(client, packageExists);
await disconnect(client);
process.exit(0);