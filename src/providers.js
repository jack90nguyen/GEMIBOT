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
    // Tương đương `claude --dangerously-skip-permissions`: adapter claude-code-acp
    // không nhận cờ CLI, nên phải set permission mode qua ACP sau khi session/new.
    permissionMode: "bypassPermissions",
    // Model set qua ACP (session/set_model) sau session/new, không qua CLI.
    modelVia: "acp",
    buildSpawn() {
      return {
        command: path.join(ACP_BIN_DIR, "claude-code-acp"),
        args: [],
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
