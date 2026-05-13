const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { randomUUID } = require("crypto");
const { log } = require("./logger");
const { MESSAGES } = require("./constants");

const CRONS_FILE = path.join(process.cwd(), "crons.json");
const scheduledTasks = new Map(); // id -> node-cron task

// enqueue được inject từ bridge.js để tránh circular dependency
let enqueueRef = null;
function setEnqueue(fn) {
  enqueueRef = fn;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function loadCrons() {
  if (!fs.existsSync(CRONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(CRONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveCrons(jobs) {
  fs.writeFileSync(CRONS_FILE, JSON.stringify(jobs, null, 2), "utf-8");
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

function scheduleCron(job) {
  if (!cron.validate(job.cron)) {
    log(`[CRON] Invalid cron expression: ${job.cron}`);
    return false;
  }

  const task = cron.schedule(job.cron, async () => {
    log(`[CRON] Triggering job id=${job.id}: ${job.description}`);
    if (!enqueueRef) {
      log(`[CRON] enqueue not set — skipping job`);
      return;
    }
    const prefix = `⏰ *${job.description}*\n\n`;
    await enqueueRef(job.chatId, job.prompt, prefix);
  });

  scheduledTasks.set(job.id, task);
  log(`[CRON] Scheduled job id=${job.id} "${job.description}" @ ${job.cron}`);
  return true;
}

function scheduleAllCrons() {
  const jobs = loadCrons();
  for (const job of jobs) {
    if (job.enabled !== false) scheduleCron(job);
  }
  log(`[CRON] Loaded ${jobs.length} cronjob(s) from crons.json`);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function addCron(chatId, { cron: cronExpr, prompt, description }) {
  if (!cron.validate(cronExpr)) {
    throw new Error(`Invalid cron expression: ${cronExpr}`);
  }
  const jobs = loadCrons();
  const job = {
    id: randomUUID().substring(0, 8),
    chatId,
    cron: cronExpr,
    prompt,
    description,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
  jobs.push(job);
  saveCrons(jobs);
  scheduleCron(job);
  return job;
}

function removeCron(id) {
  const jobs = loadCrons();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return null;
  const [removed] = jobs.splice(idx, 1);
  saveCrons(jobs);
  const task = scheduledTasks.get(id);
  if (task) {
    task.stop();
    scheduledTasks.delete(id);
  }
  return removed;
}

function unschedule(id) {
  const task = scheduledTasks.get(id);
  if (task) {
    task.stop();
    scheduledTasks.delete(id);
  }
}

function updateCron(id, patch) {
  const jobs = loadCrons();
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;

  if (patch.cron !== undefined) {
    if (!cron.validate(patch.cron)) {
      throw new Error(`Invalid cron expression: ${patch.cron}`);
    }
    job.cron = patch.cron;
  }
  if (patch.prompt !== undefined) job.prompt = patch.prompt;
  if (patch.description !== undefined) job.description = patch.description;
  if (patch.enabled !== undefined) job.enabled = !!patch.enabled;

  saveCrons(jobs);

  // Re-schedule: stop existing, then schedule again if enabled
  unschedule(id);
  if (job.enabled !== false) scheduleCron(job);

  return job;
}

function setCronEnabled(id, enabled) {
  return updateCron(id, { enabled });
}

function getAllCrons() {
  return loadCrons();
}

function getCronsForChat(chatId) {
  return loadCrons().filter((j) => j.chatId === chatId);
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatCronList(jobs) {
  if (jobs.length === 0) return MESSAGES.CRON_LIST_EMPTY;
  return (
    MESSAGES.CRON_LIST_HEADER +
    jobs
      .map(
        (j, i) =>
          `${i + 1}. \`${j.id}\` — ${j.description}\n   🕐 \`${j.cron}\`\n   💬 _${j.prompt.substring(0, 60)}${j.prompt.length > 60 ? "..." : ""}_`,
      )
      .join("\n\n")
  );
}

module.exports = {
  setEnqueue,
  scheduleAllCrons,
  addCron,
  removeCron,
  updateCron,
  setCronEnabled,
  getAllCrons,
  getCronsForChat,
  formatCronList,
};
