require("dotenv").config();
const fs = require("fs");
const path = require("path");

const { log } = require("./src/logger");
const { MESSAGES, getBotName } = require("./src/constants");
const { SYSTEM_RULES } = require("./src/prompts");
const gemini = require("./src/gemini");
const { bot, setupMessageHandler, getLastChatId } = require("./src/telegram");
const { scheduleAllCrons, setEnqueue } = require("./src/cronjob");
const { enqueue } = require("./src/queue");

// Bắt lỗi nếu tiến trình Gemini bị crash
gemini.geminiProcess.on("exit", (code) => {
  console.error(`❌ Tiến trình Gemini CLI đã thoát với mã: ${code}`);
  console.error(MESSAGES.GEMINI_PROCESS_HALT);
  bot.stopPolling();
  process.exit(code || 1);
});

// Inject enqueue vào cronjob (tránh circular dependency)
setEnqueue(enqueue);

// Khởi động
async function main() {
  console.log(MESSAGES.STARTING_GEMINI);

  try {
    await gemini.init();

    // Inject SYSTEM_RULES (hardcode, luôn có)
    log(`[INIT] Injecting SYSTEM_RULES into session...`);
    await gemini.sendPrompt(`These are the system rules you must always follow:\n${SYSTEM_RULES}`);
    log(`[INIT] SYSTEM_RULES injected successfully`);

    // Inject RULES.md nếu tồn tại (personalisation)
    const rulesPath = path.join(process.cwd(), "RULES.md");
    if (fs.existsSync(rulesPath)) {
      const rulesContent = fs.readFileSync(rulesPath, "utf-8");
      log(`[INIT] Injecting RULES.md into session...`);
      await gemini.sendPrompt(`These are personalisation rules from the user:\n\n${rulesContent}`);
      log(`[INIT] RULES.md injected successfully`);
    }

    // Inject SESSION.md nếu tồn tại (lịch sử chat của user)
    const sessionPath = path.join(process.cwd(), "SESSION.md");
    if (fs.existsSync(sessionPath)) {
      const sessionHistory = fs.readFileSync(sessionPath, "utf-8").trim();
      if (sessionHistory) {
        log(`[INIT] Injecting SESSION.md into session...`);
        await gemini.sendPrompt(
          `Đây là lịch sử các tin nhắn trước đó của user (chỉ chứa tin nhắn của user, không có response của AI). Hãy dùng context này để hiểu ngữ cảnh nếu user nhắc lại chủ đề cũ:\n\n${sessionHistory}`
        );
        log(`[INIT] SESSION.md injected successfully`);
      }
    }

    // Khởi động lại các cronjob đã lưu
    scheduleAllCrons();

    // Setup Telegram message handler
    setupMessageHandler(enqueue, gemini.getSessionId);

    const geminiModel = process.env.GEMINI_MODEL;
    console.log(MESSAGES.CONNECTED_OK);
    console.log(`🔄 Session ID: ${gemini.getSessionId()}`);
    if (geminiModel) console.log(`🧠 Model: ${geminiModel}`);
    console.log(MESSAGES.BOT_READY);

    // Thông báo online đến chatId gần nhất
    const lastChatId = getLastChatId();
    if (lastChatId) {
      bot.sendMessage(lastChatId, `${getBotName()} ${MESSAGES.ONLINE}`);
      log(`[INIT] Sent online notification to chatId=${lastChatId}`);
    }
  } catch (err) {
    console.error(MESSAGES.GEMINI_INIT_ERROR, JSON.stringify(err, null, 2));
    bot.stopPolling();
    process.exit(1);
  }
}

main();

// Dọn dẹp khi tắt bằng Ctrl+C
process.on("SIGINT", () => {
  console.log(MESSAGES.SHUTTING_DOWN);
  bot.stopPolling();
  gemini.kill();
  process.exit();
});
