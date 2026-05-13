const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { log } = require("./logger");

const HISTORY_FILE = path.join(process.cwd(), "web-history.json");
const LIMIT = Math.max(1, parseInt(process.env.WEB_HISTORY_LIMIT || "500", 10));
const FLUSH_DEBOUNCE_MS = 200;

let cache = { messages: [] };
let loaded = false;
let flushTimer = null;
let writing = false;
let dirty = false;

function loadSync() {
  if (loaded) return;
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.messages)) cache = parsed;
    }
  } catch (err) {
    log(`[WEB_HISTORY] Failed to load, starting empty`, err.message);
    cache = { messages: [] };
  }
  loaded = true;
  log(`[WEB_HISTORY] Loaded ${cache.messages.length} message(s), cap=${LIMIT}`);
}

async function flush() {
  if (writing) {
    dirty = true;
    return;
  }
  writing = true;
  dirty = false;
  try {
    const tmp = HISTORY_FILE + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(cache, null, 2), "utf-8");
    await fsp.rename(tmp, HISTORY_FILE);
  } catch (err) {
    log(`[WEB_HISTORY] Write failed`, err.message);
  } finally {
    writing = false;
    if (dirty) flush(); // re-flush if another change came during write
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_DEBOUNCE_MS);
}

function cap() {
  if (cache.messages.length > LIMIT) {
    cache.messages = cache.messages.slice(cache.messages.length - LIMIT);
  }
}

function appendMessage(msg) {
  loadSync();
  cache.messages.push(msg);
  cap();
  scheduleFlush();
}

function appendBotEvent(messageId, event) {
  loadSync();
  const msg = cache.messages.find((m) => m.id === messageId && m.role === "bot");
  if (!msg) return;
  msg.events = msg.events || [];
  msg.events.push(event);
  scheduleFlush();
}

function getHistory() {
  loadSync();
  return { messages: cache.messages };
}

async function clearHistory() {
  cache = { messages: [] };
  loaded = true;
  await flush();
  log(`[WEB_HISTORY] Cleared`);
}

module.exports = {
  loadSync,
  appendMessage,
  appendBotEvent,
  getHistory,
  clearHistory,
};
