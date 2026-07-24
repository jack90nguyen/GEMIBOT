const { log } = require("./logger");
const { addCron, removeCron, getCronsForChat, formatCronList } = require("./cronjob");

// Parse các system tags trong response của AI Agent:
//   [SEND_FILE]...[/SEND_FILE]
//   [CRONJOB_ADD]{...}[/CRONJOB_ADD]
//   [CRONJOB_DEL]{...}[/CRONJOB_DEL]
//   [CRONJOB_LIST][/CRONJOB_LIST]
//
// Returns: { cleanText, systemReply, filesToSend[] }

function parseSystemTags(text, chatId) {
  let cleanText = text;
  const replies = [];
  const filesToSend = [];

  // ── SEND_FILE ──────────────────────────────────────────────────────────────
  const sendFileRegex = /\[SEND_FILE\]([\s\S]*?)\[\/SEND_FILE\]/g;
  let sfMatch;
  while ((sfMatch = sendFileRegex.exec(text)) !== null) {
    cleanText = cleanText.replace(sfMatch[0], "").trim();
    filesToSend.push(sfMatch[1].trim());
  }

  // ── CRONJOB_ADD (nhiều tag → nhiều job) ─────────────────────────────────────
  const addRegex = /\[CRONJOB_ADD\]([\s\S]*?)\[\/CRONJOB_ADD\]/g;
  let addMatch;
  const addedIds = [];
  while ((addMatch = addRegex.exec(text)) !== null) {
    cleanText = cleanText.replace(addMatch[0], "").trim();
    try {
      const data = JSON.parse(addMatch[1].trim());
      const job = addCron(chatId, data);
      addedIds.push(job.id);
      replies.push(`✅ Đã lưu lịch: *${job.description}*\nID: \`${job.id}\` | Cron: \`${job.cron}\``);
      log(`[CRON] Added job id=${job.id} for chatId=${chatId}`);
    } catch (e) {
      replies.push(`❌ Lỗi khi tạo cronjob: ${e.message}`);
      log(`[CRON] Failed to parse CRONJOB_ADD`, e);
    }
  }

  // Đọc lại crons.json để xác nhận các job vừa tạo đã thực sự được ghi
  if (addedIds.length > 0) {
    const saved = getCronsForChat(chatId);
    const missing = addedIds.filter((id) => !saved.some((j) => j.id === id));
    if (missing.length === 0) {
      replies.push(
        `📋 Xác nhận: đã ghi ${addedIds.length} lịch vào crons.json (tổng ${saved.length} lịch đang active).`,
      );
    } else {
      replies.push(`⚠️ ${missing.length}/${addedIds.length} lịch không thấy trong crons.json sau khi lưu!`);
      log(`[CRON] Verify failed, missing ids: ${missing.join(", ")}`);
    }
  }

  // ── CRONJOB_DEL (nhiều tag → xóa nhiều job) ─────────────────────────────────
  const delRegex = /\[CRONJOB_DEL\]([\s\S]*?)\[\/CRONJOB_DEL\]/g;
  let delMatch;
  while ((delMatch = delRegex.exec(text)) !== null) {
    cleanText = cleanText.replace(delMatch[0], "").trim();
    try {
      const { id } = JSON.parse(delMatch[1].trim());
      const removed = removeCron(id);
      replies.push(
        removed
          ? `✅ Đã xóa cronjob: *${removed.description}*`
          : `❌ Không tìm thấy cronjob với ID \`${id}\``,
      );
      log(`[CRON] Deleted job id=${id}`);
    } catch (e) {
      replies.push(`❌ Lỗi khi xóa cronjob: ${e.message}`);
    }
  }

  // ── CRONJOB_LIST ──────────────────────────────────────────────────────────
  const listMatch = text.match(/\[CRONJOB_LIST\]\[\/CRONJOB_LIST\]/);
  if (listMatch) {
    cleanText = cleanText.replace(listMatch[0], "").trim();
    const jobs = getCronsForChat(chatId);
    replies.push(formatCronList(jobs));
  }

  const systemReply = replies.length > 0 ? replies.join("\n\n") : null;
  return { cleanText, systemReply, filesToSend };
}

module.exports = { parseSystemTags };
