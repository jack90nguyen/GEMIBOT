const { log } = require("./logger");
const { MESSAGES, getReactionEmoji } = require("./constants");
const { sendPrompt } = require("./gemini");
const { bot, reactToMessage, sendFileToTelegram } = require("./telegram");
const { parseSystemTags } = require("./tags");

const messageQueue = [];
let isProcessing = false;

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
    const { text: responseText } = await sendPrompt(promptText);

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
