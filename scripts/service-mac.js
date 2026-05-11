const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const SERVICE_NAME = "com.gemibot.bridge";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_NAME}.plist`);
const LOGS_DIR = path.join(PROJECT_ROOT, "logs");

function buildPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(PROJECT_ROOT, "bridge.js")}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(LOGS_DIR, "gemibot.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(LOGS_DIR, "gemibot.err.log")}</string>
</dict>
</plist>`;
}

exports.install = function () {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, buildPlist(), "utf-8");

  // Unload trước nếu đang chạy (ignore error)
  try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "ignore" }); } catch {}
  execSync(`launchctl load "${PLIST_PATH}"`);

  console.log(`✅ Service installed: ${SERVICE_NAME}`);
  console.log(`   Plist: ${PLIST_PATH}`);
  console.log(`   Logs:  ${LOGS_DIR}/gemibot.log`);
};

exports.uninstall = function () {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log("ℹ️  Service is not installed.");
    return;
  }
  try { execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "ignore" }); } catch {}
  fs.unlinkSync(PLIST_PATH);
  console.log(`✅ Service uninstalled: ${SERVICE_NAME}`);
};

exports.status = function () {
  try {
    const out = execSync(`launchctl list | grep ${SERVICE_NAME}`, { encoding: "utf-8" });
    console.log(out.trim() || "Not running");
  } catch {
    console.log("ℹ️  Service is not running.");
  }
};
