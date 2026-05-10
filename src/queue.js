const { log } = require("./logger");
const { MESSAGES, getBotName } = require("./constants");
const { sendPrompt } = require("./gemini");
const { bot, sendFileToTelegram } = require("./telegram");
const { parseSystemTags } = require("./tags");

const messageQueue = [];
let isProcessing = false;

// ─── Job Handler ──────────────────────────────────────────────────────────────

async function handleJob(job) {
  const { chatId, promptText, loadingMessage, prefix = "" } = job;

  try {
    const { text: responseText } = await sendPrompt(promptText);

    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});

    if (!responseText) {
      log(`[QUEUE] Không có nội dung phản hồi`);
      bot.sendMessage(chatId, MESSAGES.NO_RESPONSE);
      return;
    }

    const { cleanText, systemReply, filesToSend } = parseSystemTags(responseText, chatId);

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
    console.error(MESSAGES.GEMINI_CALL_ERROR, error);
    bot.deleteMessage(chatId, loadingMessage.message_id).catch(() => {});
    const errorMessage = error.message || MESSAGES.UNKNOWN_ERROR;
    bot.sendMessage(chatId, `❌ Lỗi khi giao tiếp với Gemini:\n${errorMessage}`);
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

async function enqueue(chatId, promptText, prefix = "") {
  const loadingMessage = await bot.sendMessage(chatId, `${getBotName()} ${MESSAGES.THINKING}`);
  log(`[QUEUE] Enqueued for chatId=${chatId}, queue size=${messageQueue.length + 1}`);
  messageQueue.push({ chatId, promptText, loadingMessage, prefix });
  processQueue();
}

module.exports = { enqueue, processQueue };
