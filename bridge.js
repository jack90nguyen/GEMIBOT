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

// Extensions ảnh và file thông thường
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

// Gửi file hoặc ảnh lên Telegram
async function sendFileToTelegram(chatId, filePath) {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    log(`[FILE] Not found: ${absPath}`);
    return false;
  }
  const ext = path.extname(absPath).toLowerCase();
  try {
    if (IMAGE_EXTS.has(ext)) {
      await bot.sendPhoto(chatId, absPath, { caption: path.basename(absPath) });
    } else {
      await bot.sendDocument(chatId, absPath, {
        caption: path.basename(absPath),
      });
    }
    log(`[FILE] Sent ${absPath} to chatId=${chatId}`);
    return true;
  } catch (err) {
    log(`[FILE] Failed to send ${absPath}`, err.message);
    return false;
  }
}

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

    // Khi response về -> prompt hoàn tất, lấy chunks và files đã thu thập
    pendingRequests.set(id, {
      resolve: (result) => {
        const pending = pendingPrompts.get(sessionId);
        pendingPrompts.delete(sessionId);
        const fullText = pending ? pending.chunks.join("") : "";
        log(
          `[PROMPT DONE] stopReason=${result?.stopReason}, chunks=${pending?.chunks.length}, length=${fullText.length}`,
        );
        resolve({ text: fullText });
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
    const prefix = `⏰ *${job.description}*\n\n`;
    // Wrap prompt để gắn prefix vào response
    const loadingMessage = await bot
      .sendMessage(job.chatId, "GEMIBOT 🤖 đang xử lý lịch...")
      .catch(() => null);
    messageQueue.push({
      chatId: job.chatId,
      promptText: job.prompt,
      loadingMessage: loadingMessage || { message_id: null },
      prefix,
    });
    processQueue();
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
function parseSystemTags(text, chatId) {
  let cleanText = text;
  let systemReply = null;
  const filesToSend = [];

  // SEND_FILE
  const sendFileRegex = /\[SEND_FILE\]([\s\S]*?)\[\/SEND_FILE\]/g;
  let sfMatch;
  while ((sfMatch = sendFileRegex.exec(text)) !== null) {
    cleanText = cleanText.replace(sfMatch[0], "").trim();
    filesToSend.push(sfMatch[1].trim());
  }

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

  return { cleanText, systemReply, filesToSend };
}

// ─── END CRONJOB MODULE ───────────────────────────────────────────────────────

// ─── SYSTEM RULES ─────────────────────────────────────────────────────────────
// Rules hệ thống hardcode trong code — không phụ thuộc RULES.md
const SYSTEM_RULES = `
## SYSTEM RULES (Bắt buộc tuân theo, không bao giờ bỏ qua)

### 1. CRONJOB MANAGEMENT
Khi user muốn đặt lịch / tạo nhắc nhở / tạo việc lặp lại:
- Phân tích yêu cầu và tạo cron expression phù hợp
- Thêm tag sau vào cuối response:
[CRONJOB_ADD]{"cron":"<cron_expression>","prompt":"<prompt_to_run>","description":"<mô tả ngắn>"}[/CRONJOB_ADD]

Khi user muốn xem danh sách lịch:
- Thêm tag sau vào cuối response:
[CRONJOB_LIST][/CRONJOB_LIST]

Khi user muốn xóa một lịch (cung cấp id):
- Thêm tag sau vào cuối response:
[CRONJOB_DEL]{"id":"<job_id>"}[/CRONJOB_DEL]

Cron expression format: "giây phút giờ ngày tháng thứ" (6 fields, node-cron)
Ví dụ: "0 30 8 * * 1-5" = 8:30 sáng các ngày thứ 2-6

### 2. GỬI FILE VỀ TELEGRAM
Khi bạn tạo hoặc xuất ra file mà user cần nhận (ảnh, PDF, script, data...):
- KHÔNG copy toàn bộ nội dung vào chat
- Thêm tag sau vào cuối response:
[SEND_FILE]/đường/dẫn/tuyệt/đối/tới/file.ext[/SEND_FILE]
hoặc dùng relative path từ thư mục làm việc:
[SEND_FILE]temp/filename.ext[/SEND_FILE]

Ví dụ: Tạo xong chart.png → thêm [SEND_FILE]temp/chart.png[/SEND_FILE]
`;
// ─── END SYSTEM RULES ─────────────────────────────────────────────────────────

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

    // Inject SYSTEM_RULES (hardcode, luôn có)
    log(`[INIT] Injecting SYSTEM_RULES into session...`);
    await sendPrompt(
      currentSessionId,
      `These are the system rules you must always follow:\n${SYSTEM_RULES}`,
    );
    log(`[INIT] SYSTEM_RULES injected successfully`);

    // Inject RULES.md vào đầu session nếu file tồn tại (personalisation)
    const rulesPath = path.join(process.cwd(), "RULES.md");
    if (fs.existsSync(rulesPath)) {
      const rulesContent = fs.readFileSync(rulesPath, "utf-8");
      log(`[INIT] Injecting RULES.md into session...`);
      await sendPrompt(
        currentSessionId,
        `These are personalisation rules from the user:\n\n${rulesContent}`,
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

// ─── MESSAGE QUEUE ────────────────────────────────────────────────────────────

const messageQueue = [];
let isProcessing = false;

// Xử lý một job trong queue: gửi prompt, nhận response, gửi Telegram
async function handleJob(job) {
  const { chatId, promptText, loadingMessage, prefix = "" } = job;

  try {
    const { text: responseText } = await sendPrompt(
      currentSessionId,
      promptText,
    );

    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});

    if (!responseText) {
      log(`[QUEUE] Không có nội dung phản hồi`);
      bot.sendMessage(chatId, "Xin lỗi, không có phản hồi từ Gemini.");
      return;
    }

    const { cleanText, systemReply, filesToSend } = parseSystemTags(
      responseText,
      chatId,
    );

    if (cleanText) {
      log(`[QUEUE] Gửi phản hồi, length=${cleanText.length}`);
      const finalText = prefix + cleanText;
      bot
        .sendMessage(chatId, finalText, { parse_mode: "Markdown" })
        .catch(() => bot.sendMessage(chatId, finalText));
    }

    if (systemReply) {
      bot
        .sendMessage(chatId, systemReply, { parse_mode: "Markdown" })
        .catch(() => bot.sendMessage(chatId, systemReply));
    }

    if (filesToSend.length > 0) {
      log(`[QUEUE] Sending ${filesToSend.length} file(s) to chatId=${chatId}`);
      for (const filePath of filesToSend) {
        await sendFileToTelegram(chatId, filePath);
      }
    }
  } catch (error) {
    console.error("Lỗi khi gọi Gemini:", error);
    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});
    const errorMessage = error.message || "Đã xảy ra lỗi không xác định.";
    bot.sendMessage(
      chatId,
      `❌ Lỗi khi giao tiếp với Gemini:\n${errorMessage}`,
    );
  }
}

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;
  isProcessing = true;
  const job = messageQueue.shift();
  log(
    `[QUEUE] Processing job for chatId=${job.chatId}, queue remaining=${messageQueue.length}`,
  );
  try {
    await handleJob(job);
  } finally {
    isProcessing = false;
    processQueue();
  }
}

// Enqueue một job — gửi loading message ngay, rồi đẩy vào hàng đợi
async function enqueue(chatId, promptText) {
  const loadingMessage = await bot.sendMessage(
    chatId,
    "GEMIBOT 🤖 đang suy nghĩ 🧠...",
  );
  log(
    `[QUEUE] Enqueued for chatId=${chatId}, queue size=${messageQueue.length + 1}`,
  );
  messageQueue.push({ chatId, promptText, loadingMessage });
  processQueue();
}

// ─── END MESSAGE QUEUE ────────────────────────────────────────────────────────

// Xử lý khi có tin nhắn mới từ Telegram
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;

  if (!currentSessionId) return;

  let promptText = null;

  if (msg.text) {
    promptText = msg.text;
  } else if (msg.photo || msg.document || msg.audio || msg.video || msg.voice) {
    // File/ảnh từ Telegram -> download về files/
    const uploadDir = path.join(process.cwd(), "files");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    let fileId, fileName;
    if (msg.photo) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
      fileName = `photo_${Date.now()}.jpg`;
    } else if (msg.document) {
      fileId = msg.document.file_id;
      fileName = msg.document.file_name || `doc_${Date.now()}`;
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      fileName = msg.audio.file_name || `audio_${Date.now()}.mp3`;
    } else if (msg.video) {
      fileId = msg.video.file_id;
      fileName = msg.video.file_name || `video_${Date.now()}.mp4`;
    } else if (msg.voice) {
      fileId = msg.voice.file_id;
      fileName = `voice_${Date.now()}.ogg`;
    }

    try {
      await bot.downloadFile(fileId, uploadDir);
      const tgFilePath = await bot.getFile(fileId);
      const actualPath = path.join(
        uploadDir,
        path.basename(tgFilePath.file_path),
      );
      const caption = msg.caption || "";
      promptText = `${caption ? caption + "\n\n" : ""}Tôi vừa gửi cho bạn file: ${actualPath}`;
      log(`[FILE] Downloaded from Telegram: ${actualPath}`);
    } catch (err) {
      log(`[FILE] Download error`, err.message);
      bot.sendMessage(
        chatId,
        `❌ Không thể tải file từ Telegram: ${err.message}`,
      );
      return;
    }
  }

  if (!promptText) return;

  log(`[TELEGRAM] Nhận tin từ chatId=${chatId}`, promptText.substring(0, 80));
  await enqueue(chatId, promptText);
});

// Xử lý dọn dẹp khi tắt ứng dụng bằng Ctrl+C
process.on("SIGINT", () => {
  console.log("\nĐang tắt Gemini CLI và Bot Telegram...");
  bot.stopPolling();
  geminiProcess.kill();
  process.exit();
});
