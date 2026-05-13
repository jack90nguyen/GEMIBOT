const { spawn } = require("child_process");
const readline = require("readline");
const { log } = require("./logger");

let geminiProcess = null;
let rl = null;
let currentModel = null;

let rpcId = 1;
let currentSessionId = null;
const pendingRequests = new Map();
const pendingPrompts = new Map(); // sessionId -> { chunks[] }

let intentionalRestart = false;
let exitListener = null;

function rejectAllPending(reason) {
  for (const [, { reject }] of pendingRequests) reject(reason);
  pendingRequests.clear();
  pendingPrompts.clear();
}

function attachReadline() {
  rl = readline.createInterface({ input: geminiProcess.stdout });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const message = JSON.parse(line);

      // Notification: session/update (không có id)
      if (!message.id && message.method === "session/update") {
        const { sessionId, update } = message.params || {};
        if (!sessionId || !update) return;

        const pending = pendingPrompts.get(sessionId);
        if (!pending) return;

        const { sessionUpdate, content } = update;
        log(
          `[NOTIFICATION] sessionUpdate=${sessionUpdate}`,
          content
            ? { type: content.type, text: content.text?.substring(0, 60) }
            : undefined,
        );

        if (sessionUpdate === "agent_message_chunk" && content) {
          if (content.type === "text" && content.text) {
            pending.chunks.push(content.text);
          }
        }
        return;
      }

      // JSON-RPC response (có id)
      if (message.id && pendingRequests.has(message.id)) {
        const { resolve, reject } = pendingRequests.get(message.id);
        pendingRequests.delete(message.id);

        if (message.error) {
          log(`[RESPONSE] id=${message.id} ERROR`, message.error);
          reject(message.error);
        } else {
          log(`[RESPONSE] id=${message.id}`, {
            stopReason: message.result?.stopReason,
          });
          resolve(message.result);
        }
      }
    } catch (err) {
      console.error("Lỗi parse JSON từ Gemini:", err.message);
    }
  });
}

function spawnGemini(model) {
  currentModel = model || null;
  const args = ["--acp", "--yolo"];
  if (currentModel) args.push("-m", currentModel);

  geminiProcess = spawn("gemini", args, {
    stdio: ["pipe", "pipe", "inherit"],
    detached: true, // tạo process group riêng để kill được cả con cháu khi restart
  });

  geminiProcess.on("exit", (code) => {
    if (intentionalRestart) {
      intentionalRestart = false;
      return;
    }
    if (exitListener) exitListener(code);
  });

  attachReadline();
  log(`[GEMINI] Process spawned${currentModel ? ` (model=${currentModel})` : ""}`);
}

function sendToGemini(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = rpcId++;
    const request = { jsonrpc: "2.0", id, method, params };
    pendingRequests.set(id, { resolve, reject });
    geminiProcess.stdin.write(JSON.stringify(request) + "\n");
  });
}

function sendPrompt(text) {
  return new Promise((resolve, reject) => {
    if (!currentSessionId) return reject(new Error("No active session"));

    pendingPrompts.set(currentSessionId, { chunks: [] });

    const id = rpcId++;
    const request = {
      jsonrpc: "2.0",
      id,
      method: "session/prompt",
      params: {
        sessionId: currentSessionId,
        prompt: [{ type: "text", text }],
      },
    };

    pendingRequests.set(id, {
      resolve: (result) => {
        const pending = pendingPrompts.get(currentSessionId);
        pendingPrompts.delete(currentSessionId);
        const fullText = pending ? pending.chunks.join("") : "";
        log(
          `[PROMPT DONE] stopReason=${result?.stopReason}, chunks=${pending?.chunks.length}, length=${fullText.length}`,
        );
        resolve({ text: fullText });
      },
      reject: (err) => {
        pendingPrompts.delete(currentSessionId);
        log(`[PROMPT ERROR]`, err);
        reject(err);
      },
    });

    log(`[SEND PROMPT] sessionId=${currentSessionId}`, text.substring(0, 80));
    geminiProcess.stdin.write(JSON.stringify(request) + "\n");
  });
}

async function init({ model } = {}) {
  if (!geminiProcess) spawnGemini(model);

  await sendToGemini("initialize", {
    protocolVersion: 1,
    processId: process.pid,
    capabilities: {},
    clientInfo: { name: "telegram-bot", version: "1.0.0" },
  });

  const sessionData = await sendToGemini("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });

  currentSessionId = sessionData.sessionId;
  log(`[GEMINI] Session created: ${currentSessionId}`);
  return currentSessionId;
}

async function newSession() {
  const sessionData = await sendToGemini("session/new", {
    cwd: process.cwd(),
    mcpServers: [],
  });
  currentSessionId = sessionData.sessionId;
  log(`[GEMINI] New session: ${currentSessionId}`);
  return currentSessionId;
}

function killProcessTree(proc, signal) {
  const pid = proc.pid;
  try {
    process.kill(-pid, signal); // kill cả process group (wrapper + child node)
  } catch (e) {
    try {
      proc.kill(signal);
    } catch (e2) {
      /* đã chết */
    }
  }
}

async function restart({ model } = {}) {
  log(`[GEMINI] Restarting (model=${model || currentModel || "default"})...`);
  intentionalRestart = true;
  rejectAllPending(new Error("Gemini process restarting"));

  const oldProc = geminiProcess;
  const exited = new Promise((resolve) => oldProc.once("exit", resolve));

  killProcessTree(oldProc, "SIGTERM");
  const forceTimer = setTimeout(() => {
    log(`[GEMINI] SIGTERM didn't kill pid=${oldProc.pid} in 2s, sending SIGKILL`);
    killProcessTree(oldProc, "SIGKILL");
  }, 2000);

  await exited;
  clearTimeout(forceTimer);

  rpcId = 1;
  currentSessionId = null;
  geminiProcess = null;
  rl = null;

  await init({ model: model || currentModel });
  return currentSessionId;
}

function onExit(fn) {
  exitListener = fn;
}

function getSessionId() {
  return currentSessionId;
}

function getCurrentModel() {
  return currentModel;
}

function kill() {
  if (geminiProcess) killProcessTree(geminiProcess, "SIGTERM");
}

module.exports = {
  init,
  sendToGemini,
  sendPrompt,
  newSession,
  restart,
  onExit,
  getSessionId,
  getCurrentModel,
  kill,
};
