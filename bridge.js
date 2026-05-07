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
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (IMAGE_EXTS.has(ext)) {
      await bot.sendPhoto(chatId, filePath, { caption: path.basename(filePath) });
    } else {
      await bot.sendDocument(chatId, filePath, { caption: path.basename(filePath) });
    }
    log(`[FILE] Sent ${filePath} to chatId=${chatId}`);
    return true;
  } catch (err) {
    log(`[FILE] Failed to send ${filePath}`, err.message);
    return false;
  }
}

// Parse các file path xuất hiện trong text (absolute hoặc relative ./temp/)
function extractFilePaths(text) {
  const patterns = [
    /(?:^|[\s`'"])((\/[^\s`'")\]]+)|(\.\/(temp|[^\s`'")\]]+\/)[^\s`'")\]]+))/gm,
  ];
  const found = new Set();
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = m[1].trim();
      // Chỉ lấy những path có extension (file thực sự)
      if (path.extname(p)) found.add(p);
    }
  }
  return [...found];
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

      // Theo dõi file được tạo/sửa qua tool_call_update
      if (sessionUpdate === "tool_call_update") {
        // Lấy file path từ locations
        if (update.locations?.length) {
          for (const loc of update.locations) {
            if (loc.filePath) {
              const absPath = path.isAbsolute(loc.filePath)
                ? loc.filePath
                : path.join(process.cwd(), loc.filePath);
              pending.files.add(absPath);
              log(`[FILE] Tracked file: ${absPath}`);
            }
          }
        }
        // Lấy file path từ title (thường là "write_to_file: path/to/file")
        if (update.title) {
          const titleMatch = update.title.match(/:\s*(.+\.\w+)$/);
          if (titleMatch) {
            const absPath = path.isAbsolute(titleMatch[1])
              ? titleMatch[1]
              : path.join(process.cwd(), titleMatch[1].trim());
            pending.files.add(absPath);
            log(`[FILE] Tracked from title: ${absPath}`);
          }
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
    pendingPrompts.set(sessionId, { resolve: null, reject: null, chunks: [], files: new Set() });

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
        const files = pending ? [...pending.files] : [];
        log(
          `[PROMPT DONE] stopReason=${result?.stopReason}, chunks=${pending?.chunks.length}, length=${fullText.length}, files=${files.length}`,
        );
        resolve({ text: fullText, files });
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
      const { text: responseText, files } = await sendPrompt(currentSessionId, job.prompt);
      if (responseText) {
        bot
          .sendMessage(job.chatId, `⏰ *${job.description}*\n\n${responseText}`, {
            parse_mode: "Markdown",
          })
          .catch(() =>
            bot.sendMessage(job.chatId, `⏰ ${job.description}\n\n${responseText}`)
          );
      }
      // Gửi file nếu có
      for (const filePath of files) {
        await sendFileToTelegram(job.chatId, filePath);
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

  if (!currentSessionId) return;

  // Xác định loại input và build prompt
  let promptText = null;
  let downloadedFiles = []; // file download từ Telegram về local

  if (msg.text) {
    // Text thuần
    promptText = msg.text;
  } else if (msg.photo || msg.document || msg.audio || msg.video || msg.voice) {
    // File/ảnh từ Telegram -> download về temp/
    const tempDir = path.join(process.cwd(), "temp");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    let fileId, fileName;
    if (msg.photo) {
      // Lấy ảnh chất lượng cao nhất (phần tử cuối)
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
      const destPath = path.join(tempDir, fileName);
      await bot.downloadFile(fileId, tempDir);
      // node-telegram-bot-api lưu file theo tên trên server, tìm file mới nhất
      const tgFilePath = await bot.getFile(fileId);
      const actualPath = path.join(tempDir, path.basename(tgFilePath.file_path));
      downloadedFiles.push(actualPath);
      const caption = msg.caption || "";
      promptText = `${caption ? caption + "\n\n" : ""}Tôi vừa gửi cho bạn file: ${actualPath}`;
      log(`[FILE] Downloaded from Telegram: ${actualPath}`);
    } catch (err) {
      log(`[FILE] Download error`, err.message);
      bot.sendMessage(chatId, `❌ Không thể tải file từ Telegram: ${err.message}`);
      return;
    }
  }

  if (!promptText) return;

  // Gửi thông báo đang xử lý
  const loadingMessage = await bot.sendMessage(chatId, "⏳ GEMIBOT 🤖 đang suy nghĩ...");
  log(`[TELEGRAM] Nhận tin từ chatId=${chatId}`, promptText.substring(0, 80));

  try {
    // Gửi prompt và đợi kết quả
    const { text: responseText, files: trackedFiles } = await sendPrompt(currentSessionId, promptText);

    // Xóa tin nhắn "đang suy nghĩ"
    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});

    if (!responseText && trackedFiles.length === 0) {
      log(`[TELEGRAM] Không có nội dung phản hồi`);
      bot.sendMessage(chatId, "Xin lỗi, không có phản hồi từ Gemini.");
      return;
    }

    // Parse cronjob tags từ response
    const { cleanText, systemReply } = parseCronjobTags(responseText, chatId);

    // Gửi nội dung text chính (nếu có)
    if (cleanText) {
      log(`[TELEGRAM] Gửi phản hồi, length=${cleanText.length}`);
      // Thêm các file path từ text vào danh sách gửi
      const textFilePaths = extractFilePaths(cleanText);
      for (const p of textFilePaths) trackedFiles.push(p);

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

    // Gửi các file Gemini đã tạo/sửa
    if (trackedFiles.length > 0) {
      log(`[FILE] Sending ${trackedFiles.length} file(s) to chatId=${chatId}`);
      for (const filePath of trackedFiles) {
        await sendFileToTelegram(chatId, filePath);
      }
    }
  } catch (error) {
    console.error("Lỗi khi gọi Gemini:", error);
    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});

    const errorMessage = error.message || "Đã xảy ra lỗi không xác định.";
    bot.sendMessage(chatId, `❌ Lỗi khi giao tiếp với Gemini:\n${errorMessage}`);
  }
});

// Xử lý dọn dẹp khi tắt ứng dụng bằng Ctrl+C
process.on("SIGINT", () => {
  console.log("\nĐang tắt Gemini CLI và Bot Telegram...");
  bot.stopPolling();
  geminiProcess.kill();
  process.exit();
});
