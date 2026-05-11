#!/usr/bin/env node
const cmd = process.argv[2];

if (!["install", "uninstall", "status"].includes(cmd)) {
  console.error("Usage: node scripts/service.js <install|uninstall|status>");
  process.exit(1);
}

if (process.platform === "darwin") {
  require("./service-mac")[cmd]();
} else if (process.platform === "win32") {
  require("./service-win")[cmd]();
} else {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}
