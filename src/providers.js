const path = require("path");

const ACP_BIN_DIR = path.join(__dirname, "..", "node_modules", ".bin");

const PROVIDERS = {
  gemini: {
    name: "gemini",
    label: "Gemini CLI",
    buildSpawn({ model } = {}) {
      const args = ["--acp", "--yolo"];
      if (model) args.push("-m", model);
      return { command: "gemini", args };
    },
  },
  claude: {
    name: "claude",
    label: "Claude Code CLI",
    // Tương đương `claude --dangerously-skip-permissions`: adapter claude-agent-acp
    // không nhận cờ CLI, nên phải set permission mode qua ACP sau khi session/new.
    permissionMode: "bypassPermissions",
    // Model set qua ACP (session/set_config_option, configId "model") sau session/new.
    // Adapter claude-agent-acp đã bỏ session/set_model.
    modelVia: "config",
    buildSpawn() {
      return {
        command: path.join(ACP_BIN_DIR, "claude-agent-acp"),
        args: [],
      };
    },
  },
  pi: {
    name: "pi",
    label: "Pi Agent",
    // Không set permissionMode: pi không hỏi permission, và session/set_mode của
    // pi-acp là thinking level chứ không phải permission.
    // Model dạng "provider/model" (vd google/gemini-4-argon), set qua set_config_option.
    modelVia: "config",
    buildSpawn() {
      return {
        command: path.join(ACP_BIN_DIR, "pi-acp"),
        args: [],
        // pi-acp mặc định gọi `pi` trong PATH — trỏ về bản cài local.
        env: { PI_ACP_PI_COMMAND: path.join(ACP_BIN_DIR, "pi") },
      };
    },
  },
  codex: {
    name: "codex",
    label: "Codex CLI",
    // Tương tự claude: adapter codex-acp không nhận cờ CLI. "full-access" là mode
    // bỏ qua mọi approval (tương đương yolo), set qua session/set_mode sau session/new.
    permissionMode: "full-access",
    // Model set qua ACP (session/set_model) sau session/new, không qua CLI.
    modelVia: "acp",
    buildSpawn() {
      return {
        command: path.join(ACP_BIN_DIR, "codex-acp"),
        args: [],
      };
    },
  },
};

function resolveProvider(name) {
  const key = (name || "gemini").toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    const known = Object.keys(PROVIDERS).join(", ");
    throw new Error(`Unknown provider "${name}". Available: ${known}`);
  }
  return provider;
}

module.exports = { PROVIDERS, resolveProvider };
