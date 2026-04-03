import "dotenv/config";
import { EufySecurity } from "eufy-security-client";
import fs from "fs";
import path from "path";

const DATA_DIR = "./data";
const CAPTCHA_PNG = path.join(DATA_DIR, "captcha.png");
const CAPTCHA_ID = path.join(DATA_DIR, "captcha-id.txt");

const config = {
  username: process.env.EUFY_USERNAME,
  password: process.env.EUFY_PASSWORD,
  country: "US",
  language: "en",
  persistentDir: DATA_DIR,
  p2pConnectionSetup: 2,
  pollingIntervalMinutes: 10,
  eventDurationSeconds: 10,
  logging: { level: 2 },
};

const quietLogger = {
  trace: () => {}, debug: () => {},
  info: (m, ...a) => console.log("[eufy]", m, ...a),
  warn: (m, ...a) => console.warn("[eufy]", m, ...a),
  error: (m, ...a) => console.error("[eufy]", m, ...a),
};

function writeCaptcha(id, dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
  fs.writeFileSync(CAPTCHA_PNG, Buffer.from(b64, "base64"));
  fs.writeFileSync(CAPTCHA_ID, id);
  console.log(`\nCAPTCHA required (id=${id})`);
  console.log(`  image: ${path.resolve(CAPTCHA_PNG)}`);
  console.log(`  solve it, then run: node scripts/auth.js <CODE>\n`);
}

const arg = process.argv[2];
const isTfa = arg === "--tfa";
const code = isTfa ? process.argv[3] : arg;

const eufy = await EufySecurity.initialize(config, quietLogger);

let done = false;
eufy.on("captcha request", (id, captcha) => {
  writeCaptcha(id, captcha);
  done = true;
});
eufy.on("tfa request", () => {
  console.log("\n2FA required. Get the code from email/app, then run:");
  console.log("  node scripts/auth.js --tfa <CODE>\n");
  done = true;
});
eufy.on("connect", () => {
  console.log("\n✓ Authenticated. Token saved to data/persistent.json");
  done = true;
});

let connectOpts;
if (code && isTfa) {
  connectOpts = { verifyCode: code };
  console.log("Submitting 2FA code...");
} else if (code) {
  if (!fs.existsSync(CAPTCHA_ID)) {
    console.error(`No ${CAPTCHA_ID} found — run without args first to fetch the captcha.`);
    process.exit(1);
  }
  const captchaId = fs.readFileSync(CAPTCHA_ID, "utf8").trim();
  connectOpts = { captcha: { captchaId, captchaCode: code } };
  console.log(`Submitting captcha code for id=${captchaId}...`);
} else {
  console.log("Connecting (will fetch captcha if challenged)...");
}

await eufy.connect(connectOpts);

for (let i = 0; i < 30 && !done; i++) {
  await new Promise(r => setTimeout(r, 1000));
}
if (!done && eufy.isConnected()) {
  console.log("\n✓ Authenticated (no challenge). Token saved.");
} else if (!done) {
  console.error("\nTimed out waiting for auth event. Check credentials in .env");
}

await eufy.close();
process.exit(0);
