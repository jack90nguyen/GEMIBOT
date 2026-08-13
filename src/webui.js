const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { randomUUID, createHash, timingSafeEqual } = require("crypto");
const { execFile } = require("child_process");
const { log } = require("./logger");
const { enqueue } = require("./queue");
const { appendSession, loadState, saveState } = require("./telegram");
const history = require("./webHistory");
const cronjob = require("./cronjob");
const gemini = require("./gemini");
const { injectInitContext, clearSession } = require("./initContext");

const DB_SCRIPT = path.join(process.cwd(), ".claude/skills/personal-db/db.sh");

const WEB_CHAT_ID = "__web__";

// Files viewable + editable from the Web UI. Whitelist only — no arbitrary paths.
const EDITABLE_DOCS = {
  memory: path.join(process.cwd(), "MEMORY.md"),
  rules: path.join(process.cwd(), "RULES.md"),
};

// ─── Auth ───────────────────────────────────────────────────────────────────
// Bật khi WEB_UI_PASSWORD được set; cookie HttpOnly giữ đăng nhập 30 ngày.
const AUTH_COOKIE = "web_auth";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 ngày (giây)
const WEB_PASSWORD = process.env.WEB_UI_PASSWORD || "";
const AUTH_ENABLED = WEB_PASSWORD.length > 0;
const EXPECTED_TOKEN = AUTH_ENABLED
  ? createHash("sha256").update(WEB_PASSWORD).digest("hex")
  : "";

function hashPassword(pw) {
  return createHash("sha256").update(pw).digest("hex");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k) out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  return !!token && safeEqual(token, EXPECTED_TOKEN);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

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

  // Static shell (login screen render từ đây) — không cần auth
  app.use(express.static(path.join(process.cwd(), "public")));

  // ─── Auth endpoints (không cần auth) ────────────────────────────────────────
  app.get("/api/auth", (req, res) => {
    res.json({ authed: isAuthed(req), required: AUTH_ENABLED });
  });

  app.post("/api/login", (req, res) => {
    if (!AUTH_ENABLED) return res.json({ ok: true });
    const { password } = req.body || {};
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ error: "password required" });
    }
    if (!safeEqual(hashPassword(password), EXPECTED_TOKEN)) {
      log(`[WEB] Login failed`);
      return res.status(401).json({ error: "Wrong password" });
    }
    res.setHeader(
      "Set-Cookie",
      `${AUTH_COOKIE}=${EXPECTED_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
    );
    log(`[WEB] Login success`);
    res.json({ ok: true });
  });

  // Chặn mọi API/data còn lại nếu chưa đăng nhập
  // Skip /api/memory — có requireMemoryAuth riêng (Bearer token + cookie)
  app.use("/api", (req, res, next) => {
    if (req.path.startsWith("/memory")) return next();
    requireAuth(req, res, next);
  });
  app.use("/files", requireAuth);

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

  // ─── Editable docs (MEMORY.md / RULES.md) ──────────────────────────────────

  app.get("/api/docs/:name", (req, res) => {
    const file = EDITABLE_DOCS[req.params.name];
    if (!file) return res.status(404).json({ error: "unknown doc" });
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    res.json({ name: req.params.name, content });
  });

  app.put("/api/docs/:name", async (req, res) => {
    const file = EDITABLE_DOCS[req.params.name];
    if (!file) return res.status(404).json({ error: "unknown doc" });
    const { content } = req.body || {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }
    try {
      fs.writeFileSync(file, content, "utf-8");
      log(`[WEB] Saved ${req.params.name} (${content.length} chars)`);
      // RULES.md feeds the session init context — re-inject so it applies now
      if (req.params.name === "rules") {
        await injectInitContext();
        log(`[WEB] Re-injected init context after RULES.md update`);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Memory API (shared memory for external AI agents) ─────────────────────

  const MEMORY_TOKEN = process.env.MEMORY_API_TOKEN || "";

  function requireMemoryAuth(req, res, next) {
    // Accept both Bearer token and webapp cookie
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ") && MEMORY_TOKEN) {
      const token = authHeader.slice(7);
      if (token === MEMORY_TOKEN) return next();
    }
    // Fallback to cookie auth (for webapp users)
    if (isAuthed(req)) return next();
    res.status(401).json({ error: "unauthorized" });
  }

  app.use("/api/memory", requireMemoryAuth);

  // Helper: run db.sh action and return stdout
  function runDbScript(args) {
    return new Promise((resolve, reject) => {
      execFile("bash", [DB_SCRIPT, ...args], { timeout: 10000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });
  }

  // GET /api/memory — read full MEMORY.md or a specific layer
  // ?layer=L1|L2|L3 (optional, defaults to full file)
  app.get("/api/memory", (req, res) => {
    const memFile = EDITABLE_DOCS.memory;
    if (!fs.existsSync(memFile)) return res.json({ content: "" });
    const full = fs.readFileSync(memFile, "utf-8");
    const layer = req.query.layer;
    if (!layer) return res.json({ content: full });

    // Extract specific layer section
    const pattern = new RegExp(`^## ${layer}\\b.*$`, "m");
    const match = full.match(pattern);
    if (!match) return res.status(400).json({ content: "", error: `Layer ${layer} not found` });

    const start = match.index;
    // Find next ## heading or end of file
    const rest = full.slice(start + match[0].length);
    const nextHeading = rest.match(/^## /m);
    const section = nextHeading
      ? full.slice(start, start + match[0].length + nextHeading.index)
      : full.slice(start);

    res.json({ layer, content: section.trim() });
  });

  // GET /api/memory/facts — read L1 facts only
  app.get("/api/memory/facts", (req, res) => {
    const memFile = EDITABLE_DOCS.memory;
    if (!fs.existsSync(memFile)) return res.json({ facts: [] });
    const full = fs.readFileSync(memFile, "utf-8");

    // Extract L1 section content (after heading, before next ##)
    const l1Match = full.match(/^## L1\b.*$/m);
    if (!l1Match) return res.json({ facts: [] });

    const start = l1Match.index + l1Match[0].length;
    const rest = full.slice(start);
    const nextHeading = rest.match(/^## /m);
    const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;

    // Parse bullet points as facts
    const facts = section
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2));

    res.json({ facts });
  });

  // POST /api/memory/facts — append new facts to L1
  // Body: { facts: ["fact1", "fact2"] } or { fact: "single fact" }
  app.post("/api/memory/facts", (req, res) => {
    const { facts, fact } = req.body || {};
    const newFacts = facts || (fact ? [fact] : []);
    if (!newFacts.length) {
      return res.status(400).json({ error: "facts array or fact string required" });
    }

    const memFile = EDITABLE_DOCS.memory;
    if (!fs.existsSync(memFile)) {
      return res.status(500).json({ error: "MEMORY.md not found" });
    }
    let full = fs.readFileSync(memFile, "utf-8");

    // Find L1 section
    const l1Match = full.match(/^## L1\b.*$/m);
    if (!l1Match) {
      return res.status(500).json({ error: "L1 section not found in MEMORY.md" });
    }

    // Find insertion point: end of L1 section (before next ## or EOF)
    const afterHeading = l1Match.index + l1Match[0].length;
    const rest = full.slice(afterHeading);
    const nextHeading = rest.match(/^## /m);
    const insertAt = nextHeading
      ? afterHeading + nextHeading.index
      : full.length;

    // Build new lines
    const lines = newFacts.map((f) => `- ${f}`).join("\n");
    const before = full.slice(0, insertAt).trimEnd();
    const after = full.slice(insertAt);

    full = before + "\n" + lines + "\n" + after;

    // Clean up placeholder text if present
    full = full.replace(/\n_Chưa có facts.*_\n?/, "\n");

    fs.writeFileSync(memFile, full, "utf-8");
    log(`[WEB] Memory: added ${newFacts.length} fact(s) to L1`);
    res.json({ ok: true, added: newFacts.length });
  });

  // GET /api/memory/journal — search/list journal entries
  // ?q=keyword&date=2026-08-08&category=work&limit=20
  app.get("/api/memory/journal", async (req, res) => {
    try {
      const { q, date, category, limit = "20" } = req.query;
      let result;
      if (q) {
        result = await runDbScript(["search-journal", q, category || "", limit]);
      } else if (date) {
        result = await runDbScript(["list-journal", date, category || "", limit]);
      } else {
        result = await runDbScript(["list-journal", "", category || "", limit]);
      }
      res.json({ raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/memory/journal — add a journal entry
  // Body: { content, summary?, category?, tags?, mood? }
  app.post("/api/memory/journal", async (req, res) => {
    const { content, summary = "", category = "work", tags = "", mood = "" } = req.body || {};
    if (!content) {
      return res.status(400).json({ error: "content required" });
    }
    try {
      const result = await runDbScript(["add-journal", content, summary, category, tags, mood]);
      const idMatch = result.match(/JOURNAL_ADDED_ID=(\d+)/);
      const id = idMatch ? parseInt(idMatch[1], 10) : null;
      log(`[WEB] Memory: journal entry added (id=${id})`);
      res.json({ ok: true, id, raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/memory/journal/:id — read a single journal entry (full content)
  app.get("/api/memory/journal/:id", async (req, res) => {
    try {
      const result = await runDbScript(["read-journal", req.params.id]);
      if (!result.trim()) {
        return res.status(404).json({ error: "journal entry not found", id: req.params.id });
      }
      res.json({ raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/memory/todos — list todos
  // ?filter=pending|done|all&category=work
  app.get("/api/memory/todos", async (req, res) => {
    try {
      const { filter = "pending", category = "" } = req.query;
      const result = await runDbScript(["list-todo", filter, category]);
      res.json({ raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/memory/todos — create a new todo
  app.post("/api/memory/todos", async (req, res) => {
    try {
      const { title, description, due_date, due_time, category } = req.body || {};
      if (!title) return res.status(400).json({ error: "title is required" });
      const result = await runDbScript(["add-todo", title, description || "", due_date || "", due_time || "", category || ""]);
      const idMatch = result.match(/TODO_ADDED_ID=(\d+)/);
      const id = idMatch ? parseInt(idMatch[1], 10) : null;
      res.json({ ok: true, id, raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/memory/todos/:id/done — mark todo as done
  app.patch("/api/memory/todos/:id/done", async (req, res) => {
    try {
      const result = await runDbScript(["done-todo", req.params.id]);
      if (result.includes("NOT_FOUND")) {
        return res.status(404).json({ error: "todo not found", id: req.params.id });
      }
      res.json({ ok: true, raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PATCH /api/memory/todos/:id/undone — reopen todo
  app.patch("/api/memory/todos/:id/undone", async (req, res) => {
    try {
      const result = await runDbScript(["undone-todo", req.params.id]);
      if (result.includes("NOT_FOUND")) {
        return res.status(404).json({ error: "todo not found", id: req.params.id });
      }
      res.json({ ok: true, raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/memory/todos/:id — delete a todo
  app.delete("/api/memory/todos/:id", async (req, res) => {
    try {
      const result = await runDbScript(["delete-todo", req.params.id]);
      if (result.includes("NOT_FOUND")) {
        return res.status(404).json({ error: "todo not found", id: req.params.id });
      }
      res.json({ ok: true, raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/memory/journal/:id — delete a journal entry
  app.delete("/api/memory/journal/:id", async (req, res) => {
    try {
      const result = await runDbScript(["delete-journal", req.params.id]);
      if (result.includes("NOT_FOUND")) {
        return res.status(404).json({ error: "journal entry not found", id: req.params.id });
      }
      res.json({ ok: true, raw: result.trim() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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

  // ─── Model + session control ────────────────────────────────────────────────

  app.get("/api/model", (req, res) => {
    res.json({ model: gemini.getCurrentModel() });
  });

  app.post("/api/model", async (req, res) => {
    const { model } = req.body || {};
    if (!model || typeof model !== "string") {
      return res.status(400).json({ error: "model required" });
    }
    log(`[WEB] Model change requested: ${model}`);
    try {
      saveState({ currentModel: model });
      await gemini.restart({ model });
      await injectInitContext();
      log(`[WEB] Model switched to ${model}`);
      res.json({ model });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/reset", async (req, res) => {
    log(`[WEB] Reset session requested`);
    try {
      clearSession();
      await gemini.newSession();
      await injectInitContext();
      log(`[WEB] Session reset complete`);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
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
    log(
      `[WEB] UI listening on http://${host}:${port}` +
        (AUTH_ENABLED ? " (auth enabled)" : " (no auth — WEB_UI_PASSWORD not set)"),
    );
  });
}

module.exports = { start };
