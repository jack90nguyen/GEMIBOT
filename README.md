# GEMIBOT — Gemini CLI × Telegram Bridge

Cầu nối giữa **Gemini CLI** (chạy trên máy Mac/Linux) và **Telegram**. Chat với Gemini từ bất kỳ đâu — Gemini CLI xử lý yêu cầu trực tiếp trên máy tính của bạn.

## Tính năng

- **ACP Protocol** — Giao tiếp với Gemini CLI qua Agent Client Protocol (JSON-RPC 2.0 over stdio)
- **Session management** — Duy trì ngữ cảnh hội thoại xuyên suốt
- **YOLO mode** — Gemini tự động approve tất cả tool calls, không cần xác nhận thủ công
- **Model tùy chỉnh** — Cấu hình model qua biến môi trường
- **RULES.md** — Inject rules/persona vào đầu mỗi session để AI tuân theo đúng quy tắc
- **Cronjob** — Đặt lịch chạy prompt định kỳ, AI tự hiểu và lưu lịch khi user yêu cầu
- **Debug logs** — Log chi tiết theo thời gian thực để dễ theo dõi

## Yêu cầu hệ thống

- [Gemini CLI](https://geminicli.com) đã cài và đăng nhập (`gemini login`)
- **Node.js** v18 trở lên

## Cài đặt

```bash
# 1. Clone repo
git clone <repo-url>
cd BOT-Gemini

# 2. Cài dependencies
npm install

# 3. Cấu hình .env
cp .env.example .env   # hoặc tạo file .env mới

# 4. Tạo file cá nhân hóa từ file mẫu
cp RULES.example.md RULES.md
cp MEMORY.example.md MEMORY.md
```

## Cấu hình `.env`

```env
# Bắt buộc — lấy từ @BotFather trên Telegram
TELEGRAM_BOT_TOKEN=your_token_here

# Tuỳ chọn — model mặc định khi khởi động
GEMINI_MODEL=gemini-3-flash-preview
```

## Cách chạy

```bash
npm run start
```

Khi thấy dòng sau là bot đã sẵn sàng:

```
✅ Đã kết nối thành công với Gemini CLI!
🔄 Session ID: ...
🧠 Model: gemini-3-flash-preview
🤖 Bot Telegram đã sẵn sàng nhận tin nhắn!
```

## Cấu hình AI — RULES.md

File `RULES.md` được inject vào đầu mỗi session để định nghĩa persona, rules và hành vi của AI.

> File này **không được commit** lên git — mỗi người dùng tự cấu hình riêng.
> Tạo từ file mẫu: `cp RULES.example.md RULES.md`

Ví dụ nội dung:

```markdown
## IDENTITY
- Tên: GEMIBOT
- Vai trò: lập trình viên đa năng

## RULES
- Luôn gửi kế hoạch và chờ user xác nhận trước khi thực hiện
- Lưu script vào folder `temp`
```

Chỉnh sửa `RULES.md` theo nhu cầu, bot sẽ áp dụng ngay lần khởi động tiếp theo.

## Cronjob

Bot hỗ trợ đặt lịch chạy prompt định kỳ. Chỉ cần chat tự nhiên — AI sẽ tự hiểu và xử lý.

### Đặt lịch

```
"Mỗi ngày 8h sáng báo cáo thời tiết HCM"
→ ✅ Đã lưu lịch: "Báo cáo thời tiết mỗi sáng" | ID: `a1b2c3d4` | Cron: `0 8 * * *`
```

### Xem danh sách

```
"Xem lịch của tôi"
→ 📋 Danh sách cronjob:
   1. `a1b2c3d4` — Báo cáo thời tiết mỗi sáng
      🕐 `0 8 * * *`
```

### Xóa lịch

```
"Xóa lịch a1b2c3d4"
→ ✅ Đã xóa cronjob: "Báo cáo thời tiết mỗi sáng"
```

Dữ liệu lịch được lưu vào `crons.json` và tự động khôi phục khi bot khởi động lại. Kết quả mỗi lần trigger sẽ được gửi về đúng chatId của người đặt lịch.

## Cấu trúc project

```
BOT-Gemini/
├── bridge.js           # Entry point — toàn bộ logic
├── RULES.example.md    # Mẫu cấu hình rules/persona cho AI
├── MEMORY.example.md   # Mẫu bộ nhớ dài hạn cho AI
├── .env.example        # Mẫu cấu hình môi trường
├── package.json
└── README.md

# Các file sau KHÔNG commit lên git (cá nhân hóa của từng user):
# RULES.md, MEMORY.md, crons.json, .env
```

## Lưu ý

- Máy phải bật và có Internet để bot hoạt động
- Dùng `Ctrl+C` để tắt an toàn
- Nếu thấy lỗi `409 Conflict` nghĩa là đang có 2 instance bot chạy cùng lúc — tắt bớt đi một

## Giấy phép

Mã nguồn cung cấp cho mục đích học tập và cá nhân.
