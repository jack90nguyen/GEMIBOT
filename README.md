# Gemini CLI - Telegram Bridge

Dự án này là một cầu nối (bridge) giúp bạn kết nối **Gemini CLI** (chạy trên máy Mac/Linux của bạn) với **Telegram**. Bạn có thể chat với Gemini từ bất kỳ đâu thông qua Telegram, và yêu cầu sẽ được xử lý bởi chính Gemini CLI đang chạy trên máy tính của bạn.

## Tính năng
- Kết nối thông qua giao thức **ACP (Agent Client Protocol)** nhanh và ổn định.
- Duy trì ngữ cảnh cuộc trò chuyện (Session management).
- Phản hồi nhanh theo thời gian thực.
- Tự động xóa thông báo chờ sau khi có kết quả.

## Yêu cầu hệ thống
- Đã cài đặt [Gemini CLI](https://geminicli.com).
- Đã đăng nhập và xác thực Gemini CLI trên máy (`gemini login`).
- Đã cài đặt **Node.js** (Phiên bản 18 trở lên).

## Cài đặt

1. **Clone hoặc tải thư mục này về máy.**
2. **Cài đặt thư viện:**
   ```bash
   npm install
   ```
3. **Cấu hình Token:**
   - Tạo một Bot Telegram thông qua [@BotFather](https://t.me/botfather).
   - Sao chép Token của Bot.
   - Mở file `.env` và dán Token vào:
     ```env
     TELEGRAM_BOT_TOKEN=điền_token_của_bạn_vào_đây
     ```

## Cách chạy

Chạy lệnh sau trong terminal:
```bash
node bridge.js
```

Khi màn hình hiện ✅ `Đã kết nối thành công với Gemini CLI!`, bạn có thể bắt đầu chat với Bot trên Telegram.

## Lưu ý
- Máy Mac của bạn phải đang bật và kết nối Internet để Bot có thể xử lý tin nhắn.
- Nếu bạn tắt terminal chạy `bridge.js`, Bot trên Telegram sẽ ngừng hoạt động.
- Sử dụng `Ctrl+C` để tắt ứng dụng một cách an toàn.

## Giấy phép
Mã nguồn này được cung cấp cho mục đích học tập và cá nhân.
