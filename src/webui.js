const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { randomUUID } = require("crypto");
const { log } = require("./logger");
const { enqueue } = require("./queue");
const { appendSession, loadState } = require("./telegram");
const history = require("./webHistory");
const cronjob = require("./cronjob");

const WEB_CHAT_ID = "__web__";

// ─── Emitter (per request) ────────────────────────────────────────────────────

const emitters = new Map();

function createEmitter() {
  let buffer = [];
  let listener = null;
  let closed = false;
  return {
    emit(event) {
      if (listener) listener(event);
      else buffer.push(event);
    },
    attach(fn) {
      listener = fn;
      const pending = buffer;
      buffer = [];
      for (const e of pending) fn(e);
      if (closed) fn({ type: "end" });
    },
    close() {
      closed = true;
      if (listener) listener({ type: "end" });
    },
  };
}

function buildWebReply(emitter, botMsgId) {
  return {
    text: (content, { markdown = false } = {}) => {
      const ev = { type: "text", content, markdown };
      emitter.emit(ev);
      history.appendBotEvent(botMsgId, ev);
    },
    file: (filePath) => {
      const ev = {
        type: "file",
        path: filePath,
        name: path.basename(filePath),
      };
      emitter.emit(ev);
      history.appendBotEvent(botMsgId, ev);
    },
    error: (msg) => {
      const ev = { type: "error", message: msg };
      emitter.emit(ev);
      history.appendBotEvent(botMsgId, ev);
    },
    done: () => emitter.close(),
  };
}

// ─── Upload ───────────────────────────────────────────────────────────────────

const uploadDir = path.join(process.cwd(), "files");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ─── App ──────────────────────────────────────────────────────────────────────

function start(port, host) {
  history.loadSync();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(process.cwd(), "public")));

  // Serve uploaded files for inline preview (images) and download
  app.use("/files", express.static(uploadDir));

  // Serve arbitrary absolute paths (e.g. files AI created in /tmp or elsewhere)
  app.get("/api/file", (req, res) => {
    const raw = req.query.path;
    if (!raw || typeof raw !== "string") {
      return res.status(400).json({ error: "path required" });
    }
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: "file not found", path: abs });
    }
    res.sendFile(abs);
  });

  app.post("/api/upload", upload.array("files", 10), (req, res) => {
    const files = (req.files || []).map((f) => ({
      path: f.path,
      name: f.originalname,
      size: f.size,
    }));
    log(`[WEB] Uploaded ${files.length} file(s)`);
    res.json({ files });
  });

  app.post("/api/chat", async (req, res) => {
    const { text, filePaths = [] } = req.body || {};
    if (!text && filePaths.length === 0) {
      return res.status(400).json({ error: "text or filePaths required" });
    }

    let promptText = text || "";
    if (filePaths.length > 0) {
      const fileLines = filePaths
        .map((p) => `Tôi vừa gửi cho bạn file: ${p}`)
        .join("\n");
      promptText = promptText ? `${promptText}\n\n${fileLines}` : fileLines;
    }

    const id = randomUUID();
    const botMsgId = randomUUID();
    const emitter = createEmitter();
    emitters.set(id, emitter);

    // Cleanup if SSE consumer never connects (5 min TTL)
    setTimeout(() => {
      if (emitters.has(id)) {
        log(`[WEB] Emitter ${id} expired without consumer`);
        emitters.delete(id);
      }
    }, 5 * 60 * 1000);

    log(`[WEB] Chat id=${id}, text="${promptText.substring(0, 60)}"`);
    appendSession(promptText);

    history.appendMessage({
      id: randomUUID(),
      ts: Date.now(),
      role: "user",
      text: text || "",
      files: filePaths.map((p) => ({ path: p, name: path.basename(p) })),
    });
    history.appendMessage({
      id: botMsgId,
      ts: Date.now(),
      role: "bot",
      events: [],
    });

    const reply = buildWebReply(emitter, botMsgId);
    const { position } = await enqueue(WEB_CHAT_ID, promptText, "", null, reply);

    res.json({ id, position });
  });

  app.get("/api/history", (req, res) => {
    res.json(history.getHistory());
  });

  app.delete("/api/history", async (req, res) => {
    await history.clearHistory();
    res.json({ ok: true });
  });

  // ─── Cron management ───────────────────────────────────────────────────────

  app.get("/api/crons", (req, res) => {
    res.json({ crons: cronjob.getAllCrons() });
  });

  app.post("/api/crons", (req, res) => {
    const { cron, prompt, description } = req.body || {};
    if (!cron || !prompt || !description) {
      return res.status(400).json({ error: "cron, prompt, description are required" });
    }
    const lastChatId = loadState().lastChatId;
    if (!lastChatId) {
      return res.status(400).json({
        error: "No Telegram chat target. Please message the bot on Telegram at least once first.",
      });
    }
    try {
      const job = cronjob.addCron(lastChatId, { cron, prompt, description });
      log(`[WEB] Cron created id=${job.id} (chatId=${lastChatId})`);
      res.json({ cron: job });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch("/api/crons/:id", (req, res) => {
    const { id } = req.params;
    const patch = req.body || {};
    try {
      const job = cronjob.updateCron(id, patch);
      if (!job) return res.status(404).json({ error: "Cron not found" });
      log(`[WEB] Cron updated id=${id}`);
      res.json({ cron: job });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete("/api/crons/:id", (req, res) => {
    const { id } = req.params;
    const removed = cronjob.removeCron(id);
    if (!removed) return res.status(404).json({ error: "Cron not found" });
    log(`[WEB] Cron deleted id=${id}`);
    res.json({ ok: true });
  });

  app.get("/api/stream/:id", (req, res) => {
    const { id } = req.params;
    const emitter = emitters.get(id);
    if (!emitter) return res.status(404).end();

    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const send = (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "end") {
        res.end();
        emitters.delete(id);
      }
    };

    // Heartbeat to keep connection alive through proxies
    const heartbeat = setInterval(() => {
      res.write(": ping\n\n");
    }, 15000);

    emitter.attach(send);

    req.on("close", () => {
      clearInterval(heartbeat);
      emitters.delete(id);
    });
  });

  app.listen(port, host, () => {
    log(`[WEB] UI listening on http://${host}:${port}`);
  });
}

module.exports = { start };
