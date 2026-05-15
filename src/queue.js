const { log } = require("./logger");
const { MESSAGES, getReactionEmoji } = require("./constants");
const { sendPrompt } = require("./gemini");
const { bot, reactToMessage, sendFileToTelegram } = require("./telegram");
const { parseSystemTags } = require("./tags");

const messageQueue = [];
let isProcessing = false;

// ─── Retry config ─────────────────────────────────────────────────────────────

const RETRY_MAX = Math.max(0, parseInt(process.env.GEMINI_RETRY_MAX || "3", 10));
const RETRY_DELAYS = (process.env.GEMINI_RETRY_DELAYS || "2000,5000,10000")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n >= 0);

const TRANSIENT_PATTERNS = [
  /no capacity/i,
  /overloaded/i,
  /rate ?limit/i,
  /\b429\b/,
  /\b503\b/,
  /\b504\b/,
  /econnreset/i,
  /etimedout/i,
  /socket hang up/i,
  /network error/i,
];

function errorMessage(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || JSON.stringify(err);
}

function isTransientError(err) {
  const msg = errorMessage(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendPromptWithRetry(promptText, reply) {
  let attempt = 0;
  while (true) {
    try {
      return await sendPrompt(promptText);
    } catch (err) {
      if (attempt >= RETRY_MAX || !isTransientError(err)) throw err;
      const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1] ?? 2000;
      const seconds = Math.round(delay / 1000);
      const next = attempt + 1;
      log(`[QUEUE] Transient error, retry ${next}/${RETRY_MAX} in ${seconds}s: ${errorMessage(err)}`);
      try {
        await reply.text(`⏳ ${errorMessage(err)}\nRetrying in ${seconds}s... (${next}/${RETRY_MAX})`);
      } catch {}
      await sleep(delay);
      attempt = next;
    }
  }
}

// ─── Reply abstraction ────────────────────────────────────────────────────────
// reply = { text(content, {markdown}), file(absPath), error(msg), done() }

function defaultTelegramReply(chatId) {
  return {
    text: (content, { markdown = false } = {}) => {
      const opts = markdown ? { parse_mode: "Markdown" } : {};
      return bot
        .sendMessage(chatId, content, opts)
        .catch(() => bot.sendMessage(chatId, content));
    },
    file: (filePath) => sendFileToTelegram(chatId, filePath),
    error: (msg) => bot.sendMessage(chatId, `❌ Lỗi khi giao tiếp với Gemini:\n${msg}`),
    done: () => {},
  };
}

// ─── Job Handler ──────────────────────────────────────────────────────────────

async function handleJob(job) {
  const { chatId, promptText, prefix = "", reply } = job;

  try {
    const { text: responseText } = await sendPromptWithRetry(promptText, reply);

    if (!responseText) {
      log(`[QUEUE] Không có nội dung phản hồi`);
      await reply.text(MESSAGES.NO_RESPONSE);
      return;
    }

    const { cleanText, systemReply, filesToSend } = parseSystemTags(responseText, chatId);

    if (cleanText) {
      log(`[QUEUE] Gửi phản hồi, length=${cleanText.length}`);
      await reply.text(prefix + cleanText, { markdown: true });
    }

    if (systemReply) {
      await reply.text(systemReply, { markdown: true });
    }

    if (filesToSend.length > 0) {
      log(`[QUEUE] Sending ${filesToSend.length} file(s) to chatId=${chatId}`);
      for (const filePath of filesToSend) {
        await reply.file(filePath);
      }
    }
  } catch (error) {
    console.error(MESSAGES.GEMINI_CALL_ERROR, error);
    const errorMessage = error.message || MESSAGES.UNKNOWN_ERROR;
    await reply.error(errorMessage);
  } finally {
    reply.done();
  }
}

// ─── Queue ────────────────────────────────────────────────────────────────────

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

async function enqueue(chatId, promptText, prefix = "", messageId = null, reply = null) {
  if (messageId) {
    reactToMessage(chatId, messageId, getReactionEmoji());
  }
  const resolvedReply = reply || defaultTelegramReply(chatId);
  const position = messageQueue.length + (isProcessing ? 1 : 0);
  log(`[QUEUE] Enqueued for chatId=${chatId}, queue size=${messageQueue.length + 1}`);
  messageQueue.push({ chatId, promptText, prefix, reply: resolvedReply });
  processQueue();
  return { position };
}

module.exports = { enqueue, processQueue };
