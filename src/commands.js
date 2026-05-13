const { log } = require("./logger");
const { getCronsForChat, formatCronList } = require("./cronjob");
const gemini = require("./gemini");
const { injectInitContext, clearSession } = require("./initContext");
const { saveState } = require("./telegram");

// ─── Handlers ─────────────────────────────────────────────────────────────────

const handlers = {
  reset: async (msg, args, ctx) => {
    await ctx.bot.sendMessage(msg.chat.id, "🧹 Đang reset session…");
    clearSession();
    await gemini.newSession();
    await injectInitContext();
    await ctx.bot.sendMessage(msg.chat.id, "✅ Đã reset. Bắt đầu phiên mới.");
  },

  model: async (msg, args, ctx) => {
    const newModel = args.trim();
    if (!newModel) {
      const cur = gemini.getCurrentModel() || "(default)";
      await ctx.bot.sendMessage(
        msg.chat.id,
        `🧠 Model hiện tại: \`${cur}\`\nDùng: \`/model <tên>\``,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await ctx.bot.sendMessage(
      msg.chat.id,
      `🔄 Đang đổi sang \`${newModel}\`…`,
      { parse_mode: "Markdown" },
    );
    saveState({ currentModel: newModel });

    try {
      await gemini.restart({ model: newModel });
      await injectInitContext();
      await ctx.bot.sendMessage(
        msg.chat.id,
        `✅ Đã đổi sang \`${newModel}\``,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      await ctx.bot.sendMessage(msg.chat.id, `❌ Đổi model thất bại: ${err.message}`);
    }
  },

  crons: async (msg, args, ctx) => {
    const jobs = getCronsForChat(msg.chat.id);
    await ctx.bot.sendMessage(msg.chat.id, formatCronList(jobs), { parse_mode: "Markdown" });
  },
};

// ─── Parser ───────────────────────────────────────────────────────────────────

// /cmd  hoặc  /cmd@botname args...
function parseCommand(text, botUsername) {
  if (!text || !text.startsWith("/")) return null;
  const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const [, name, addressedBot, rest] = m;
  if (addressedBot && botUsername && addressedBot !== botUsername) return null;
  return { name: name.toLowerCase(), args: rest || "" };
}

async function handleCommand(msg, ctx) {
  const parsed = parseCommand(msg.text, ctx.botUsername);
  if (!parsed) return false;
  const fn = handlers[parsed.name];
  if (!fn) return false; // fall-through cho Gemini xử lý như prompt thường

  log(`[CMD] /${parsed.name} from chatId=${msg.chat.id}`, parsed.args || "(no args)");
  try {
    await fn(msg, parsed.args, ctx);
  } catch (err) {
    console.error(`[CMD] /${parsed.name} error`, err);
    await ctx.bot.sendMessage(msg.chat.id, `❌ Lỗi command /${parsed.name}: ${err.message}`);
  }
  return true;
}

// ─── Menu (cho bot.setMyCommands) ─────────────────────────────────────────────

function getCommandMenu() {
  return [
    { command: "reset", description: "Xoá session, bắt đầu phiên mới" },
    { command: "model", description: "Xem hoặc đổi model Gemini" },
    { command: "crons", description: "Liệt kê cronjob của bạn" },
  ];
}

module.exports = { handleCommand, getCommandMenu };
