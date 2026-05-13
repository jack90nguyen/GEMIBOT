require("dotenv").config();

const { log } = require("./src/logger");
const { MESSAGES, getBotName } = require("./src/constants");
const gemini = require("./src/gemini");
const {
  bot,
  setupMessageHandler,
  getLastChatId,
  initBotInfo,
  loadState,
} = require("./src/telegram");
const { scheduleAllCrons, setEnqueue } = require("./src/cronjob");
const { enqueue } = require("./src/queue");
const { injectInitContext } = require("./src/initContext");
const { handleCommand, getCommandMenu } = require("./src/commands");

// Bắt lỗi nếu tiến trình Gemini bị crash ngoài ý muốn
gemini.onExit((code) => {
  console.error(`❌ Tiến trình Gemini CLI đã thoát với mã: ${code}`);
  console.error(MESSAGES.GEMINI_PROCESS_HALT);
  bot.stopPolling();
  process.exit(code || 1);
});

// Inject enqueue vào cronjob (tránh circular dependency)
setEnqueue(enqueue);

async function main() {
  console.log(MESSAGES.STARTING_GEMINI);

  try {
    const initialModel = loadState().currentModel || process.env.GEMINI_MODEL || null;
    await gemini.init({ model: initialModel });

    const injectionPromise = injectInitContext();

    // Song song: lấy thông tin bot để xử lý mention trong group
    await initBotInfo();

    console.log(MESSAGES.CONNECTED_OK);
    console.log(`🔄 Session ID: ${gemini.getSessionId()}`);
    if (initialModel) console.log(`🧠 Model: ${initialModel}`);
    console.log(MESSAGES.BOT_READY);

    // Thông báo online NGAY, không đợi injection xong
    const lastChatId = getLastChatId();
    if (lastChatId) {
      bot.sendMessage(lastChatId, `${getBotName()} ${MESSAGES.ONLINE}`);
      log(`[INIT] Sent online notification to chatId=${lastChatId}`);
    }

    // Đăng ký menu slash command (không cần đợi)
    bot
      .setMyCommands(getCommandMenu())
      .then(() => log(`[INIT] Slash command menu registered`))
      .catch((err) => log(`[INIT] setMyCommands failed`, err.message));

    // Khi injection xong → attach handler + cron (để tránh race với pendingPrompts)
    injectionPromise
      .then(() => {
        log(`[INIT] Init context injected, bot fully ready`);
        setupMessageHandler(enqueue, gemini.getSessionId, handleCommand);
        scheduleAllCrons();
      })
      .catch((err) => {
        console.error("Init context injection failed:", err);
        bot.stopPolling();
        process.exit(1);
      });
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
