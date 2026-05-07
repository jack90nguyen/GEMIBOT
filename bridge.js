require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { randomUUID } = require("crypto");

// Lấy Token từ file .env
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN_HERE") {
  console.error("❌ Lỗi: Bạn chưa cấu hình TELEGRAM_BOT_TOKEN trong file .env");
  console.error(
    "Vui lòng mở file .env và thay thế YOUR_TELEGRAM_BOT_TOKEN_HERE bằng token thật của bạn.",
  );
  process.exit(1);
}

// Khởi tạo Bot Telegram
const bot = new TelegramBot(token, { polling: true });

const geminiModel = process.env.GEMINI_MODEL;

console.log("Đang khởi động Gemini CLI trong nền...");
// Khởi chạy tiến trình Gemini bằng giao thức ACP
const geminiArgs = ["--acp", "--yolo"];
if (geminiModel) geminiArgs.push("-m", geminiModel);
const geminiProcess = spawn("gemini", geminiArgs, {
  stdio: ["pipe", "pipe", "inherit"],
});

let rpcId = 1;
let currentSessionId = null;
const pendingRequests = new Map();

// Map từ sessionId -> { resolve, reject, chunks } để thu thập notification chunks
const pendingPrompts = new Map();

function log(label, data) {
  const time = new Date().toISOString().substring(11, 23);
  if (data !== undefined) {
    console.log(
      `[${time}] ${label}`,
      typeof data === "object" ? JSON.stringify(data) : data,
    );
  } else {
    console.log(`[${time}] ${label}`);
  }
}

// Bắt lỗi nếu tiến trình Gemini bị crash
geminiProcess.on("exit", (code) => {
  console.error(`❌ Tiến trình Gemini CLI đã thoát với mã: ${code}`);
  console.error("Dừng Bot Telegram để đảm bảo an toàn.");
  bot.stopPolling();
  process.exit(code || 1);
});

// Đọc kết quả trả về từ stdout của Gemini
const rl = readline.createInterface({ input: geminiProcess.stdout });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);

    // Xử lý notification (không có id) - ví dụ: session/update
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

      // Thu thập các chunk nội dung phản hồi từ agent
      if (sessionUpdate === "agent_message_chunk" && content) {
        if (content.type === "text" && content.text) {
          pending.chunks.push(content.text);
        }
      }
      return;
    }

    // Xử lý JSON-RPC response (có id)
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

// Hàm gửi request xuống Gemini qua luồng stdin
function sendToGemini(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = rpcId++;
    const request = {
      jsonrpc: "2.0",
      id: id,
      method: method,
      params: params,
    };
    pendingRequests.set(id, { resolve, reject });
    geminiProcess.stdin.write(JSON.stringify(request) + "\n");
  });
}

// Hàm gửi prompt và đợi kết quả qua notifications
function sendPrompt(sessionId, text) {
  return new Promise((resolve, reject) => {
    // Đăng ký listener trước khi gửi request
    pendingPrompts.set(sessionId, { resolve: null, reject: null, chunks: [] });

    const id = rpcId++;
    const request = {
      jsonrpc: "2.0",
      id: id,
      method: "session/prompt",
      params: {
        sessionId: sessionId,
        prompt: [{ type: "text", text: text }],
      },
    };

    // Khi response về -> prompt hoàn tất, lấy chunks đã thu thập
    pendingRequests.set(id, {
      resolve: (result) => {
        const pending = pendingPrompts.get(sessionId);
        pendingPrompts.delete(sessionId);
        const fullText = pending ? pending.chunks.join("") : "";
        log(
          `[PROMPT DONE] stopReason=${result?.stopReason}, chunks=${pending?.chunks.length}, length=${fullText.length}`,
        );
        resolve(fullText);
      },
      reject: (err) => {
        pendingPrompts.delete(sessionId);
        log(`[PROMPT ERROR]`, err);
        reject(err);
      },
    });

    log(`[SEND PROMPT] sessionId=${sessionId}`, text.substring(0, 80));
    geminiProcess.stdin.write(JSON.stringify(request) + "\n");
  });
}

// ─── CRONJOB MODULE ───────────────────────────────────────────────────────────

const CRONS_FILE = path.join(process.cwd(), "crons.json");
const scheduledTasks = new Map(); // id -> node-cron task

function loadCrons() {
  if (!fs.existsSync(CRONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CRONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveCrons(jobs) {
  fs.writeFileSync(CRONS_FILE, JSON.stringify(jobs, null, 2), "utf-8");
}

function scheduleCron(job) {
  if (!cron.validate(job.cron)) {
    log(`[CRON] Invalid cron expression: ${job.cron}`);
    return false;
  }
  const task = cron.schedule(job.cron, async () => {
    log(`[CRON] Triggering job id=${job.id}: ${job.description}`);
    try {
      const responseText = await sendPrompt(currentSessionId, job.prompt);
      if (responseText) {
        bot
          .sendMessage(
            job.chatId,
            `⏰ *${job.description}*\n\n${responseText}`,
            {
              parse_mode: "Markdown",
            },
          )
          .catch(() =>
            bot.sendMessage(
              job.chatId,
              `⏰ ${job.description}\n\n${responseText}`,
            ),
          );
      }
    } catch (err) {
      log(`[CRON] Error running job id=${job.id}`, err);
      bot.sendMessage(
        job.chatId,
        `❌ Cronjob "${job.description}" gặp lỗi: ${err.message}`,
      );
    }
  });
  scheduledTasks.set(job.id, task);
  log(`[CRON] Scheduled job id=${job.id} "${job.description}" @ ${job.cron}`);
  return true;
}

function scheduleAllCrons() {
  const jobs = loadCrons();
  for (const job of jobs) {
    if (job.enabled !== false) scheduleCron(job);
  }
  log(`[CRON] Loaded ${jobs.length} cronjob(s) from crons.json`);
}

function addCron(chatId, { cron: cronExpr, prompt, description }) {
  const jobs = loadCrons();
  const job = {
    id: randomUUID().substring(0, 8),
    chatId,
    cron: cronExpr,
    prompt,
    description,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  jobs.push(job);
  saveCrons(jobs);
  scheduleCron(job);
  return job;
}

function removeCron(id) {
  const jobs = loadCrons();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  const [removed] = jobs.splice(idx, 1);
  saveCrons(jobs);
  const task = scheduledTasks.get(id);
  if (task) {
    task.stop();
    scheduledTasks.delete(id);
  }
  return removed;
}

function getCronsForChat(chatId) {
  return loadCrons().filter((j) => j.chatId === chatId);
}

function formatCronList(jobs) {
  if (jobs.length === 0) return "📭 Bạn chưa có cronjob nào.";
  return (
    "📋 *Danh sách cronjob của bạn:*\n\n" +
    jobs
      .map(
        (j, i) =>
          `${i + 1}. \`${j.id}\` — ${j.description}\n   🕐 \`${j.cron}\`\n   💬 _${j.prompt.substring(0, 60)}${j.prompt.length > 60 ? "..." : ""}_`,
      )
      .join("\n\n")
  );
}

// Parse và xử lý các tag CRONJOB từ response của Gemini
function parseCronjobTags(text, chatId) {
  let cleanText = text;
  let systemReply = null;

  // CRONJOB_ADD
  const addMatch = text.match(/\[CRONJOB_ADD\]([\s\S]*?)\[\/CRONJOB_ADD\]/);
  if (addMatch) {
    cleanText = cleanText.replace(addMatch[0], "").trim();
    try {
      const data = JSON.parse(addMatch[1].trim());
      const job = addCron(chatId, data);
      systemReply = `✅ Đã lưu lịch: *${job.description}*\nID: \`${job.id}\` | Cron: \`${job.cron}\``;
      log(`[CRON] Added job id=${job.id} for chatId=${chatId}`);
    } catch (e) {
      systemReply = `❌ Lỗi khi tạo cronjob: ${e.message}`;
      log(`[CRON] Failed to parse CRONJOB_ADD`, e);
    }
  }

  // CRONJOB_DEL
  const delMatch = text.match(/\[CRONJOB_DEL\]([\s\S]*?)\[\/CRONJOB_DEL\]/);
  if (delMatch) {
    cleanText = cleanText.replace(delMatch[0], "").trim();
    try {
      const { id } = JSON.parse(delMatch[1].trim());
      const removed = removeCron(id);
      systemReply = removed
        ? `✅ Đã xóa cronjob: *${removed.description}*`
        : `❌ Không tìm thấy cronjob với ID \`${id}\``;
      log(`[CRON] Deleted job id=${id}`);
    } catch (e) {
      systemReply = `❌ Lỗi khi xóa cronjob: ${e.message}`;
    }
  }

  // CRONJOB_LIST
  const listMatch = text.match(/\[CRONJOB_LIST\]\[\/CRONJOB_LIST\]/);
  if (listMatch) {
    cleanText = cleanText.replace(listMatch[0], "").trim();
    const jobs = getCronsForChat(chatId);
    systemReply = formatCronList(jobs);
  }

  return { cleanText, systemReply };
}

// ─── END CRONJOB MODULE ───────────────────────────────────────────────────────

// Hàm khởi tạo session với Gemini
async function initGemini() {
  try {
    await sendToGemini("initialize", {
      protocolVersion: 1,
      processId: process.pid,
      capabilities: {},
      clientInfo: { name: "telegram-bot", version: "1.0.0" },
    });

    // Dùng đúng method name: session/new, với params bắt buộc cwd và mcpServers
    const sessionData = await sendToGemini("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
    currentSessionId = sessionData.sessionId;

    // Inject RULES.md vào đầu session nếu file tồn tại
    const rulesPath = path.join(process.cwd(), "RULES.md");
    if (fs.existsSync(rulesPath)) {
      const rulesContent = fs.readFileSync(rulesPath, "utf-8");
      log(`[INIT] Injecting RULES.md into session...`);
      await sendPrompt(
        currentSessionId,
        `Please follow these rules for all responses:\n\n${rulesContent}`,
      );
      log(`[INIT] RULES.md injected successfully`);
    }

    console.log(`✅ Đã kết nối thành công với Gemini CLI!`);
    console.log(`🔄 Session ID: ${currentSessionId}`);
    if (geminiModel) console.log(`🧠 Model: ${geminiModel}`);
    console.log("🤖 Bot Telegram đã sẵn sàng nhận tin nhắn!");

    // Khởi động lại các cronjob đã lưu
    scheduleAllCrons();
  } catch (err) {
    console.error("❌ Lỗi khi khởi tạo Gemini:", JSON.stringify(err, null, 2));
    bot.stopPolling();
    process.exit(1);
  }
}

// Chạy khởi tạo
initGemini();

// Xử lý khi có tin nhắn mới từ Telegram
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || !currentSessionId) return;

  // Gửi thông báo đang xử lý
  const loadingMessage = await bot.sendMessage(
    chatId,
    "⏳ GEMIBOT 🤖 đang suy nghĩ...",
  );
  log(`[TELEGRAM] Nhận tin từ chatId=${chatId}`, text.substring(0, 80));

  try {
    // Gửi prompt và đợi kết quả qua notifications
    const responseText = await sendPrompt(currentSessionId, text);

    // Xóa tin nhắn "đang suy nghĩ"
    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});

    if (!responseText) {
      log(`[TELEGRAM] Không có nội dung phản hồi`);
      bot.sendMessage(chatId, "Xin lỗi, không có phản hồi từ Gemini.");
      return;
    }

    // Parse cronjob tags từ response
    const { cleanText, systemReply } = parseCronjobTags(responseText, chatId);

    // Gửi nội dung chính (nếu có)
    if (cleanText) {
      log(`[TELEGRAM] Gửi phản hồi, length=${cleanText.length}`);
      bot
        .sendMessage(chatId, cleanText, { parse_mode: "Markdown" })
        .catch(() => bot.sendMessage(chatId, cleanText));
    }

    // Gửi thông báo kết quả cronjob action (nếu có)
    if (systemReply) {
      log(`[TELEGRAM] Gửi cronjob reply`);
      bot
        .sendMessage(chatId, systemReply, { parse_mode: "Markdown" })
        .catch(() => bot.sendMessage(chatId, systemReply));
    }
  } catch (error) {
    console.error("Lỗi khi gọi Gemini:", error);
    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});

    // Hiển thị chi tiết lỗi nếu có
    const errorMessage = error.message
      ? error.message
      : "Đã xảy ra lỗi không xác định.";
    bot.sendMessage(
      chatId,
      `❌ Lỗi khi giao tiếp với Gemini:\n${errorMessage}`,
    );
  }
});

// Xử lý dọn dẹp khi tắt ứng dụng bằng Ctrl+C
process.on("SIGINT", () => {
  console.log("\nĐang tắt Gemini CLI và Bot Telegram...");
  bot.stopPolling();
  geminiProcess.kill();
  process.exit();
});
