# GEMIBOT — Gemini CLI / Claude Code / Codex × Telegram Bridge

Cầu nối giữa **AI CLI provider** (Gemini CLI, Claude Code CLI hoặc Codex CLI) chạy trên máy Mac/Linux và **Telegram**. Chat với AI từ bất kỳ đâu — provider xử lý yêu cầu trực tiếp trên máy tính của bạn.

## Tính năng

- **ACP Protocol** — Giao tiếp với provider qua Agent Client Protocol (JSON-RPC 2.0 over stdio)
- **Multi-provider** — Chọn giữa Gemini CLI, Claude Code CLI và Codex CLI qua biến `PROVIDER`
- **Session management** — Duy trì ngữ cảnh hội thoại xuyên suốt
- **YOLO / Bypass Permissions** — Provider tự động approve tất cả tool calls, không cần xác nhận thủ công
- **Model tùy chỉnh** — Cấu hình model qua biến môi trường
- **Tên bot tuỳ chỉnh** — Đổi tên hiển thị trong tin nhắn qua biến `BOT_NAME`
- **Group chat** — Cấu hình bot tự động reply hoặc chỉ reply khi được @tag/reply
- **System Rules** — Rules hệ thống hardcode trong code, không phụ thuộc file cá nhân
- **RULES.md** — Inject persona/rules cá nhân hóa vào đầu mỗi session
- **Cronjob** — Đặt lịch chạy prompt định kỳ, AI tự hiểu và lưu lịch khi user yêu cầu
- **Gửi/nhận file** — Nhận file từ Telegram, gửi file/ảnh từ Gemini về Telegram qua tag `[SEND_FILE]`
- **Message Queue** — Xử lý tuần tự, không mất tin khi nhận nhiều message cùng lúc
- **Thông báo online** — Gửi tin nhắn đến chatId gần nhất khi bot khởi động xong
- **Debug logs** — Log chi tiết theo thời gian thực để dễ theo dõi

## Yêu cầu hệ thống

- **Node.js** v18 trở lên
- Một trong các provider (tuỳ chọn `PROVIDER` trong `.env`):
  - [Gemini CLI](https://geminicli.com) đã cài và đăng nhập (`gemini login`) — cho `PROVIDER=gemini`
  - [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) đã cài và đăng nhập (`claude login`) — cho `PROVIDER=claude`. Adapter `@zed-industries/claude-code-acp` được cài tự động qua `npm install`.
  - [Codex CLI](https://developers.openai.com/codex) đã đăng nhập (`codex login`) hoặc đặt `CODEX_API_KEY` — cho `PROVIDER=codex`. Adapter `@zed-industries/codex-acp` được cài tự động qua `npm install`.

## Cài đặt

```bash
# 1. Clone repo
git clone <repo-url>
cd GEMIBOT

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

# Tuỳ chọn — provider ACP: "gemini" (mặc định), "claude" hoặc "codex"
# - gemini: dùng Gemini CLI (cần `gemini` đã cài và login)
# - claude: dùng Claude Code CLI qua adapter @zed-industries/claude-code-acp
#           (cần `claude` đã login; tự động bật bypassPermissions tương đương
#            `claude --dangerously-skip-permissions`)
# - codex:  dùng Codex CLI qua adapter @zed-industries/codex-acp
#           (cần `codex login` hoặc CODEX_API_KEY; tự động bật full-access tương đương yolo)
PROVIDER=gemini

# Tuỳ chọn — model mặc định khi khởi động, dùng chung cho mọi provider.
# Để trống = mỗi provider tự dùng model mặc định. Ví dụ:
#   gemini: gemini-3-flash-preview | gemini-3-pro-preview | auto-gemini-3
#   claude: default (Opus) | sonnet | haiku
#   codex:  gpt-5.5 | gpt-5.4 | gpt-5.4-mini | gpt-5.3-codex
PROVIDER_MODEL=

# Tuỳ chọn — tên hiển thị của bot trong tin nhắn (mặc định: GEMIBOT 🤖)
BOT_NAME=GEMIBOT 🤖

# Tuỳ chọn — chế độ trả lời trong group: "mention" (chỉ khi @tag hoặc reply, mặc định) hoặc "always"
GROUP_REPLY_MODE=mention
```

> **Cách áp model**: Gemini nhận model qua tham số CLI `-m` lúc khởi động; Claude/Codex set qua ACP (`session/set_model`) sau khi tạo session. Lệnh `/model <tên>` hoạt động cho cả ba.
>
> **Lưu ý**: Claude/Codex **không báo lỗi nếu tên model sai** — sẽ âm thầm dùng model mặc định. Gemini sai model sẽ lỗi khi khởi động.

## Cách chạy

```bash
# Chạy foreground (debug / thử nghiệm)
npm run start
```

### Chạy nền như service (khuyến nghị)

Bot sẽ tự động **restart khi crash** và **tự start lại khi boot máy / login**.

```bash
# Cài và khởi động service
npm run service:install

# Kiểm tra trạng thái
npm run service:status

# Gỡ cài đặt
npm run service:uninstall
```

**macOS** — không cần sudo. Dùng `launchd` LaunchAgent (user-level).

```bash
# Xem log
tail -f logs/gemibot.log
tail -f logs/gemibot.err.log
```

**Windows** — mở terminal (PowerShell / CMD) **as Administrator** rồi chạy `npm run service:install`. Dùng Windows Service qua `node-windows`.

> **Lưu ý Windows**: nếu Gemini CLI báo lỗi xác thực, mở `scripts/service-win.js`, bỏ comment block `logOnAs` và điền username/password của user Windows, rồi chạy lại `service:install`.
>
> Xem log: vào **services.msc** → GEMIBOT → Properties, hoặc xem thư mục `daemon/` trong project.

Khi thấy dòng sau là bot đã sẵn sàng:

```
✅ Đã kết nối thành công với Gemini CLI!
🤖 Provider: gemini
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
GEMIBOT/
├── bridge.js           # Entry point — bootstrap & wiring
├── scripts/
│   ├── service.js      # Entrypoint: detect platform, dispatch
│   ├── service-mac.js  # macOS launchd installer
│   └── service-win.js  # Windows service installer (node-windows)
├── src/
│   ├── logger.js       # Log helper với timestamp
│   ├── constants.js    # Tất cả text/message dùng trong bot
│   ├── prompts.js      # System rules hardcode (cronjob + file tags)
│   ├── providers.js    # Provider config (gemini / claude) cho ACP client
│   ├── gemini.js       # ACP protocol, spawn process, sendPrompt
│   ├── cronjob.js      # CRUD + schedule cronjobs
│   ├── tags.js         # Parse [CRONJOB_*] và [SEND_FILE] tags
│   ├── telegram.js     # Bot instance, sendFile, message handler
│   └── queue.js        # Message queue, enqueue, processQueue
├── RULES.example.md    # Mẫu cấu hình rules/persona cho AI
├── MEMORY.example.md   # Mẫu bộ nhớ dài hạn cho AI
├── .env.example        # Mẫu cấu hình môi trường
├── package.json
└── README.md

# Các file sau KHÔNG commit lên git (cá nhân hóa của từng user):
# RULES.md, MEMORY.md, crons.json, state.json, .env
```

## Lưu ý

- Máy phải bật và có Internet để bot hoạt động
- Dùng `Ctrl+C` để tắt an toàn
- Nếu thấy lỗi `409 Conflict` nghĩa là đang có 2 instance bot chạy cùng lúc — tắt bớt đi một

## Giấy phép

> Developed by jack90nguyen (Thành DEV)