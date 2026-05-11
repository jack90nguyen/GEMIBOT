const path = require("path");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SERVICE_NAME = "GEMIBOT";

function makeSvc() {
  const { Service } = require("node-windows");
  return new Service({
    name: SERVICE_NAME,
    description: "Gemini CLI × Telegram Bridge",
    script: path.join(PROJECT_ROOT, "bridge.js"),
    workingDirectory: PROJECT_ROOT,
    // Bỏ comment và điền thông tin nếu Gemini CLI báo lỗi xác thực:
    // logOnAs: { account: "TÊN_USER_WINDOWS", password: "MẬT_KHẨU" }
  });
}

exports.install = function () {
  const svc = makeSvc();
  svc.on("install", () => {
    console.log(`✅ Service installed: ${SERVICE_NAME}`);
    svc.start();
  });
  svc.on("alreadyinstalled", () => {
    console.log("ℹ️  Service already installed. Uninstall first to reinstall.");
  });
  svc.install();
};

exports.uninstall = function () {
  const svc = makeSvc();
  svc.on("uninstall", () => console.log(`✅ Service uninstalled: ${SERVICE_NAME}`));
  svc.on("notinstalled", () => console.log("ℹ️  Service is not installed."));
  svc.uninstall();
};

exports.status = function () {
  try {
    const out = execSync(`sc query ${SERVICE_NAME}`, { encoding: "utf-8" });
    const stateMatch = out.match(/STATE\s*:\s*\d+\s+(\w+)/);
    const state = stateMatch ? stateMatch[1] : "UNKNOWN";
    console.log(`Service ${SERVICE_NAME}: ${state}`);
  } catch {
    console.log("ℹ️  Service is not installed.");
  }
};
