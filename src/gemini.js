const { spawn } = require("child_process");
const readline = require("readline");
const { log } = require("./logger");

const geminiModel = process.env.GEMINI_MODEL;

// Spawn Gemini CLI process
const geminiArgs = ["--acp", "--yolo"];
if (geminiModel) geminiArgs.push("-m", geminiModel);

const geminiProcess = spawn("gemini", geminiArgs, {
  stdio: ["pipe", "pipe", "inherit"],
});

let rpcId = 1;
let currentSessionId = null;
const pendingRequests = new Map();
const pendingPrompts = new Map(); // sessionId -> { chunks[] }

// Đọc stdout từ Gemini (JSON-RPC notifications + responses)
const rl = readline.createInterface({ input: geminiProcess.stdout });

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

      // Thu thập các chunk nội dung phản hồi
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

// Gửi JSON-RPC request xuống Gemini qua stdin
function sendToGemini(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = rpcId++;
    const request = { jsonrpc: "2.0", id, method, params };
    pendingRequests.set(id, { resolve, reject });
    geminiProcess.stdin.write(JSON.stringify(request) + "\n");
  });
}

// Gửi prompt và đợi kết quả (thu thập notification chunks)
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

// Khởi tạo ACP session với Gemini CLI
async function init() {
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

function getSessionId() {
  return currentSessionId;
}

function kill() {
  geminiProcess.kill();
}

module.exports = { init, sendToGemini, sendPrompt, getSessionId, kill, geminiProcess };
