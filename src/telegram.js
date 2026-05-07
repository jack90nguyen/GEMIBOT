const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { log } = require("./logger");

const STATE_FILE = path.join(process.cwd(), "state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveState(data) {
  const current = loadState();
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...data }, null, 2), "utf-8");
}

function getLastChatId() {
  return loadState().lastChatId || null;
}

function saveLastChatId(chatId) {
  saveState({ lastChatId: chatId });
}

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN_HERE") {
  console.error("❌ Lỗi: Bạn chưa cấu hình TELEGRAM_BOT_TOKEN trong file .env");
  console.error(
    "Vui lòng mở file .env và thay thế YOUR_TELEGRAM_BOT_TOKEN_HERE bằng token thật của bạn.",
  );
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// ─── File Sending ─────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

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
      await bot.sendDocument(chatId, absPath, { caption: path.basename(absPath) });
    }
    log(`[FILE] Sent ${absPath} to chatId=${chatId}`);
    return true;
  } catch (err) {
    log(`[FILE] Failed to send ${absPath}`, err.message);
    return false;
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

// enqueue được inject từ bridge.js
function setupMessageHandler(enqueue, getSessionId) {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;

    if (!getSessionId()) return;

    // Lưu lại chatId gần nhất để dùng khi bot restart
    saveLastChatId(chatId);

    let promptText = null;

    if (msg.text) {
      promptText = msg.text;
    } else if (msg.photo || msg.document || msg.audio || msg.video || msg.voice) {
      // Download file về thư mục files/
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
        const actualPath = path.join(uploadDir, path.basename(tgFilePath.file_path));
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

    log(`[TELEGRAM] Nhận tin từ chatId=${chatId}`, promptText.substring(0, 80));
    await enqueue(chatId, promptText);
  });
}

module.exports = { bot, sendFileToTelegram, setupMessageHandler, getLastChatId };
