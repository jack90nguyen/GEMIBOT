const fs = require("fs");
const path = require("path");
const { log } = require("./logger");
const { SYSTEM_RULES } = require("./prompts");
const gemini = require("./gemini");

const SESSION_FILE = path.join(process.cwd(), "SESSION.md");
const RULES_FILE = path.join(process.cwd(), "RULES.md");
const SESSION_LIMIT = parseInt(process.env.SESSION_HISTORY_LIMIT || "0", 10);

function clearSession() {
  if (SESSION_LIMIT <= 0) return;
  fs.writeFileSync(SESSION_FILE, "", "utf-8");
  log(`[INIT] SESSION.md cleared`);
}

function buildInitContext() {
  const parts = [`These are the system rules you must always follow:\n${SYSTEM_RULES}`];

  if (fs.existsSync(RULES_FILE)) {
    const rulesContent = fs.readFileSync(RULES_FILE, "utf-8");
    parts.push(`These are personalisation rules from the user:\n\n${rulesContent}`);
  }

  if (SESSION_LIMIT > 0 && fs.existsSync(SESSION_FILE)) {
    const sessionHistory = fs.readFileSync(SESSION_FILE, "utf-8").trim();
    if (sessionHistory) {
      parts.push(
        `Đây là lịch sử các tin nhắn trước đó của user (chỉ chứa tin nhắn của user, không có response của AI). Hãy dùng context này để hiểu ngữ cảnh nếu user nhắc lại chủ đề cũ:\n\n${sessionHistory}`,
      );
    }
  }

  return parts;
}

async function injectInitContext() {
  const parts = buildInitContext();
  log(`[INIT] Injecting init context (${parts.length} sections)...`);
  return gemini.sendPrompt(parts.join("\n\n---\n\n"));
}

module.exports = { injectInitContext, clearSession };
