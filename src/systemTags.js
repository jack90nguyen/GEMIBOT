const { log } = require("./logger");
const { addCron, removeCron, getCronsForChat, formatCronList } = require("./cronjob");

// Parse các system tags trong response của Gemini:
//   [SEND_FILE]...[/SEND_FILE]
//   [CRONJOB_ADD]{...}[/CRONJOB_ADD]
//   [CRONJOB_DEL]{...}[/CRONJOB_DEL]
//   [CRONJOB_LIST][/CRONJOB_LIST]
//
// Returns: { cleanText, systemReply, filesToSend[] }

function parseSystemTags(text, chatId) {
  let cleanText = text;
  let systemReply = null;
  const filesToSend = [];

  // ── SEND_FILE ──────────────────────────────────────────────────────────────
  const sendFileRegex = /\[SEND_FILE\]([\s\S]*?)\[\/SEND_FILE\]/g;
  let sfMatch;
  while ((sfMatch = sendFileRegex.exec(text)) !== null) {
    cleanText = cleanText.replace(sfMatch[0], "").trim();
    filesToSend.push(sfMatch[1].trim());
  }

  // ── CRONJOB_ADD ───────────────────────────────────────────────────────────
  const addMatch = text.match(/\[CRONJOB_ADD\]([\s\S]*?)\[\/CRONJOB_ADD\]/);
  if (addMatch) {
    cleanText = cleanText.replace(addMatch[0], "").trim();
    try {
      const data = JSON.parse(addMatch[1].trim());
      const job = addCron(chatId, data);
      systemReply = `✅ Đã lưu lịch: *${job.description}*\nID: \`${job.id}\` | Cron: \`${job.cron}\``;
      log(`[CRON] Added job id=${job.id} for chatId=${chatId}`);
    } catch (e) {
      systemReply = `❌ Lỗi khi tạo cronjob: ${e.message}`;
      log(`[CRON] Failed to parse CRONJOB_ADD`, e);
    }
  }

  // ── CRONJOB_DEL ───────────────────────────────────────────────────────────
  const delMatch = text.match(/\[CRONJOB_DEL\]([\s\S]*?)\[\/CRONJOB_DEL\]/);
  if (delMatch) {
    cleanText = cleanText.replace(delMatch[0], "").trim();
    try {
      const { id } = JSON.parse(delMatch[1].trim());
      const removed = removeCron(id);
      systemReply = removed
        ? `✅ Đã xóa cronjob: *${removed.description}*`
        : `❌ Không tìm thấy cronjob với ID \`${id}\``;
      log(`[CRON] Deleted job id=${id}`);
    } catch (e) {
      systemReply = `❌ Lỗi khi xóa cronjob: ${e.message}`;
    }
  }

  // ── CRONJOB_LIST ──────────────────────────────────────────────────────────
  const listMatch = text.match(/\[CRONJOB_LIST\]\[\/CRONJOB_LIST\]/);
  if (listMatch) {
    cleanText = cleanText.replace(listMatch[0], "").trim();
    const jobs = getCronsForChat(chatId);
    systemReply = formatCronList(jobs);
  }

  return { cleanText, systemReply, filesToSend };
}

module.exports = { parseSystemTags };
