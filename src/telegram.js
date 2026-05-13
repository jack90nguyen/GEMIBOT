const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const { log } = require("./logger");
const { MESSAGES, getReactionEmoji } = require("./constants");

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

const SESSION_FILE = path.join(process.cwd(), "SESSION.md");
const SESSION_LIMIT = parseInt(process.env.SESSION_HISTORY_LIMIT || "100", 10);

function appendSession(text) {
  const timestamp = new Date().toISOString().replace("T", " ").substring(0, 19);
  const line = `[${timestamp}] ${text.replace(/\n/g, " ")}`;

  // Đọc các dòng hiện có
  let lines = [];
  if (fs.existsSync(SESSION_FILE)) {
    lines = fs.readFileSync(SESSION_FILE, "utf-8").split("\n").filter(Boolean);
  }

  lines.push(line);

  // Giữ lại N dòng cuối
  if (lines.length > SESSION_LIMIT) {
    lines = lines.slice(lines.length - SESSION_LIMIT);
  }

  fs.writeFileSync(SESSION_FILE, lines.join("\n") + "\n", "utf-8");
}

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN_HERE") {
  console.error(MESSAGES.MISSING_TOKEN);
  console.error(MESSAGES.MISSING_TOKEN_HINT);
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const GROUP_REPLY_MODE = (process.env.GROUP_REPLY_MODE || "mention").toLowerCase();

// ─── Bot Identity ─────────────────────────────────────────────────────────────

let botInfo = null;

async function initBotInfo() {
  botInfo = await bot.getMe();
  log(`[INIT] Bot identity: @${botInfo.username} (id=${botInfo.id})`);
}

function findBotMention(msg) {
  const entities = msg.entities || msg.caption_entities || [];
  const text = msg.text || msg.caption || "";
  for (const e of entities) {
    if (e.type === "mention") {
      const at = text.substring(e.offset, e.offset + e.length);
      if (at === `@${botInfo.username}`) return e;
    } else if (e.type === "text_mention" && e.user?.id === botInfo.id) {
      return e;
    }
  }
  return null;
}

function isReplyToBot(msg) {
  return msg.reply_to_message?.from?.id === botInfo.id;
}

function stripMention(text, entity) {
  if (!text || !entity) return text || "";
  const before = text.substring(0, entity.offset);
  const after = text.substring(entity.offset + entity.length);
  return (before + after).replace(/\s+/g, " ").trim();
}

// ─── Reactions ────────────────────────────────────────────────────────────────

async function reactToMessage(chatId, messageId, emoji) {
  try {
    await bot._request("setMessageReaction", {
      form: {
        chat_id: chatId,
        message_id: messageId,
        reaction: JSON.stringify([{ type: "emoji", emoji }]),
      },
    });
  } catch (err) {
    log(`[REACT] Failed to react ${emoji} on msg=${messageId}`, err.message);
  }
}

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

// enqueue + handleCommand được inject từ bridge.js
function setupMessageHandler(enqueue, getSessionId, handleCommand) {
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;

    if (!getSessionId()) return;

    const isPrivate = msg.chat.type === "private";
    let mention = null;
    if (!isPrivate) {
      mention = findBotMention(msg);
      if (GROUP_REPLY_MODE !== "always") {
        if (!mention && !isReplyToBot(msg)) return;
      }
    }

    // Lưu lại chatId gần nhất để dùng khi bot restart
    if (isPrivate) saveLastChatId(chatId);

    // Intercept slash command trước khi đẩy vào Gemini
    const textForCmd = mention && msg.text ? stripMention(msg.text, mention) : msg.text;
    if (handleCommand && textForCmd && textForCmd.startsWith("/")) {
      const cmdMsg = { ...msg, text: textForCmd };
      const handled = await handleCommand(cmdMsg, { bot, botUsername: botInfo?.username });
      if (handled) {
        reactToMessage(chatId, msg.message_id, getReactionEmoji());
        return;
      }
    }

    let promptText = null;

    if (msg.text) {
      promptText = mention ? stripMention(msg.text, mention) : msg.text;
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
        const rawCaption = msg.caption || "";
        const caption = mention ? stripMention(rawCaption, mention) : rawCaption;
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
    appendSession(promptText);
    await enqueue(chatId, promptText, "", msg.message_id);
  });
}

module.exports = { bot, reactToMessage, sendFileToTelegram, setupMessageHandler, getLastChatId, initBotInfo, loadState, saveState };
