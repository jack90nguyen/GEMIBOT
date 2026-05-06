require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const readline = require('readline');

// Lấy Token từ file .env
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    console.error("❌ Lỗi: Bạn chưa cấu hình TELEGRAM_BOT_TOKEN trong file .env");
    console.error("Vui lòng mở file .env và thay thế YOUR_TELEGRAM_BOT_TOKEN_HERE bằng token thật của bạn.");
    process.exit(1);
}

// Khởi tạo Bot Telegram
const bot = new TelegramBot(token, { polling: true });

console.log("Đang khởi động Gemini CLI trong nền...");
// Khởi chạy tiến trình Gemini bằng giao thức ACP
const geminiProcess = spawn('gemini', ['--experimental-acp'], {
    stdio: ['pipe', 'pipe', 'inherit']
});

let rpcId = 1;
let currentSessionId = null;
const pendingRequests = new Map();

// Đọc kết quả trả về từ stdout của Gemini
const rl = readline.createInterface({ input: geminiProcess.stdout });

rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
        const response = JSON.parse(line);
        if (response.id && pendingRequests.has(response.id)) {
            const callback = pendingRequests.get(response.id);
            pendingRequests.delete(response.id);
            callback(response.result);
        }
    } catch (err) {
        console.error("Lỗi parse JSON từ Gemini:", err.message);
    }
});

// Hàm gửi request xuống Gemini qua luồng stdin
function sendToGemini(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = rpcId++;
        const request = {
            jsonrpc: "2.0",
            id: id,
            method: method,
            params: params
        };
        pendingRequests.set(id, { resolve, reject });
        geminiProcess.stdin.write(JSON.stringify(request) + '\n');
    });
}

// Hàm khởi tạo session với Gemini
async function initGemini() {
    try {
        await sendToGemini('initialize', { 
            protocolVersion: "2024-11-05",
            processId: process.pid,
            capabilities: {},
            clientInfo: { name: "telegram-bot", version: "1.0.0" } 
        });
        const sessionData = await sendToGemini('newSession');
        currentSessionId = sessionData.sessionId;
        
        console.log(`✅ Đã kết nối thành công với Gemini CLI!`);
        console.log(`🔄 Session ID: ${currentSessionId}`);
        console.log("🤖 Bot Telegram đã sẵn sàng nhận tin nhắn!");
    } catch (err) {
        console.error("❌ Lỗi khi khởi tạo Gemini:", JSON.stringify(err, null, 2));
        process.exit(1);
    }
}

// Chạy khởi tạo
initGemini();

// Xử lý khi có tin nhắn mới từ Telegram
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text || !currentSessionId) return;

    // Gửi thông báo đang xử lý
    bot.sendMessage(chatId, "⏳ Gemini đang suy nghĩ...");

    try {
        // Chuyển câu hỏi xuống Gemini CLI
        const result = await sendToGemini('prompt', {
            sessionId: currentSessionId,
            prompt: text
        });

        // Trả kết quả ngược lại cho Telegram
        if (result && result.content) {
            bot.sendMessage(chatId, result.content);
        } else {
            bot.sendMessage(chatId, "Xin lỗi, không có phản hồi từ Gemini.");
        }
    } catch (error) {
        console.error("Lỗi khi gọi Gemini:", error);
        bot.sendMessage(chatId, "Đã xảy ra lỗi khi giao tiếp với Gemini.");
    }
});

// Xử lý dọn dẹp khi tắt ứng dụng bằng Ctrl+C
process.on('SIGINT', () => {
    console.log("\nĐang tắt Gemini CLI...");
    geminiProcess.kill();
    process.exit();
});
'SIGINT', () => {
    console.log("\nĐang tắt Gemini CLI...");
    geminiProcess.kill();
    process.exit();
});
