const DEFAULT_BOT_NAME = "ONEBOT";

const getBotName = () => process.env.BOT_NAME || DEFAULT_BOT_NAME;
const getReactionEmoji = () => process.env.REACTION_EMOJI || "🤔";

const MESSAGES = {
  // === Telegram (gửi cho user) ===
  ONLINE: "🤖 đã online, sẵn sàng đợi lệnh! 🫡",
  THINKING: "🧠 đang suy nghĩ...",
  NO_RESPONSE: "Xin lỗi, không có phản hồi từ AI Agent.",
  UNKNOWN_ERROR: "Đã xảy ra lỗi không xác định.",
  CRON_LIST_EMPTY: "📭 Bạn chưa có cronjob nào.",
  CRON_LIST_HEADER: "📋 *Danh sách cronjob của bạn:*\n\n",

  // === Console startup / shutdown ===
  STARTING_GEMINI: "Đang khởi động ONEBOT trong nền...",
  CONNECTED_OK: "✅ Đã kết nối thành công với ONEBOT!",
  BOT_READY: "🤖 Bot Telegram đã sẵn sàng nhận tin nhắn!",
  WEB_ONLY_MODE: "⚠️  Không có TELEGRAM_BOT_TOKEN — chạy ở chế độ Web UI only.",
  WEB_ONLY_READY: "🌐 Chế độ Web UI only — Telegram đã bị tắt.",
  GEMINI_INIT_ERROR: "❌ Lỗi khi khởi tạo ACP-Provider:",
  SHUTTING_DOWN: "\nĐang tắt ONEBOT và Bot Telegram...",
  GEMINI_PROCESS_HALT: "Dừng Bot Telegram để đảm bảo an toàn.",
  GEMINI_CALL_ERROR: "Lỗi khi gọi ACP-Provider:",

  // === Token validation (console) ===
  MISSING_TOKEN: "❌ Lỗi: Bạn chưa cấu hình TELEGRAM_BOT_TOKEN trong file .env",
  MISSING_TOKEN_HINT:
    "Vui lòng mở file .env và thay thế YOUR_TELEGRAM_BOT_TOKEN_HERE bằng token thật của bạn.",
};

module.exports = { MESSAGES, DEFAULT_BOT_NAME, getBotName, getReactionEmoji };
