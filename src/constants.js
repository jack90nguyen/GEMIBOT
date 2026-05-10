const DEFAULT_BOT_NAME = "GEMIBOT 🤖";

const getBotName = () => process.env.BOT_NAME || DEFAULT_BOT_NAME;

const MESSAGES = {
  // === Telegram (gửi cho user) ===
  ONLINE: "đã online, sẵn sàng đợi lệnh!",
  THINKING: "🧠 đang suy nghĩ...",
  NO_RESPONSE: "Xin lỗi, không có phản hồi từ Gemini.",
  UNKNOWN_ERROR: "Đã xảy ra lỗi không xác định.",
  CRON_LIST_EMPTY: "📭 Bạn chưa có cronjob nào.",
  CRON_LIST_HEADER: "📋 *Danh sách cronjob của bạn:*\n\n",

  // === Console startup / shutdown ===
  STARTING_GEMINI: "Đang khởi động Gemini CLI trong nền...",
  CONNECTED_OK: "✅ Đã kết nối thành công với Gemini CLI!",
  BOT_READY: "🤖 Bot Telegram đã sẵn sàng nhận tin nhắn!",
  GEMINI_INIT_ERROR: "❌ Lỗi khi khởi tạo Gemini:",
  SHUTTING_DOWN: "\nĐang tắt Gemini CLI và Bot Telegram...",
  GEMINI_PROCESS_HALT: "Dừng Bot Telegram để đảm bảo an toàn.",
  GEMINI_CALL_ERROR: "Lỗi khi gọi Gemini:",

  // === Token validation (console) ===
  MISSING_TOKEN: "❌ Lỗi: Bạn chưa cấu hình TELEGRAM_BOT_TOKEN trong file .env",
  MISSING_TOKEN_HINT:
    "Vui lòng mở file .env và thay thế YOUR_TELEGRAM_BOT_TOKEN_HERE bằng token thật của bạn.",
};

module.exports = { MESSAGES, DEFAULT_BOT_NAME, getBotName };
