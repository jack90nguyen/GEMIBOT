# PHÈN DEV — Memory API

Shared memory system for AI agents. All agents (Claude Code, Codex, Gemini, etc.) can read/write to a central memory managed by PHÈN DEV.

## Authentication

All endpoints require Bearer token authentication.

```
Authorization: Bearer <MEMORY_API_TOKEN>
```

Token is configured in PHÈN DEV's `.env` file. Ask the admin for access.

## Base URL

```
https://onebot.onetez.com
```

## Endpoints

### 1. Read Memory

Read the full shared memory file or a specific layer.

```
GET /api/memory
GET /api/memory?layer=L1
GET /api/memory?layer=L2
GET /api/memory?layer=L3
```

**Response:**
```json
{ "content": "# MEMORY.md\n\n## L3 — Persona ..." }
```

With `?layer=L1`:
```json
{ "layer": "L1", "content": "## L1 — Facts ...\n- fact1\n- fact2" }
```

Invalid layer returns **400**:
```json
{ "content": "", "error": "Layer L9 not found" }
```

**Memory Layers:**
- **L3 — Persona**: User profile, preferences, tone (rarely changes)
- **L2 — Context**: Business context, projects, services (changes per project/quarter)
- **L1 — Facts**: Atomic facts distilled from journal (updated weekly)

---

### 2. Read Facts

Get L1 facts as a structured array.

```
GET /api/memory/facts
```

**Response:**
```json
{ "facts": ["ImagixAI has 30+ internal users", "emboss-service uses 50% cheaper model"] }
```

---

### 3. Write Facts

Append new facts to L1 memory.

```
POST /api/memory/facts
Content-Type: application/json
```

**Body (multiple facts):**
```json
{ "facts": ["New fact 1", "New fact 2"] }
```

**Body (single fact):**
```json
{ "fact": "Single new fact" }
```

**Response:**
```json
{ "ok": true, "added": 2 }
```

---

### 4. Read Journal

Search or list journal entries (daily logs, notes, events).

```
GET /api/memory/journal
GET /api/memory/journal?q=keyword
GET /api/memory/journal?date=2026-08-08
GET /api/memory/journal?category=work&limit=10
```

**Query params:**
- `q` — search keyword (searches content, summary, tags)
- `date` — filter by date (YYYY-MM-DD)
- `category` — filter by category (work, health, etc.)
- `limit` — max results (default: 20)

**Response:**
```json
{ "raw": "id  content_preview  summary  category  tags  mood  created_at\n..." }
```

> Note: List/search returns `content_preview` (first 200 chars). Use `GET /api/memory/journal/:id` for full content.

---

### 5. Read Single Journal Entry

Get full content of a specific journal entry.

```
GET /api/memory/journal/:id
```

**Response (200):**
```json
{ "raw": "id  content  summary  category  tags  mood  created_at\n..." }
```

**Response (404):**
```json
{ "error": "journal entry not found", "id": "999" }
```

---

### 6. Write Journal

Add a new journal entry.

```
POST /api/memory/journal
Content-Type: application/json
```

**Body:**
```json
{
  "content": "What happened today (required)",
  "summary": "Short summary (optional)",
  "category": "work",
  "tags": "tag1,tag2",
  "mood": "happy"
}
```

**Response:**
```json
{ "ok": true, "id": 27, "raw": "JOURNAL_ADDED_ID=27" }
```

> Note: `id` field contains the actual inserted ID as a number.

---

### 7. Delete Journal Entry

```
DELETE /api/memory/journal/:id
```

**Response (200):**
```json
{ "ok": true, "raw": "JOURNAL_DELETED: 27" }
```

**Response (404):**
```json
{ "error": "journal entry not found", "id": "999" }
```

---

### 8. Read Todos

List pending/done/all tasks.

```
GET /api/memory/todos
GET /api/memory/todos?filter=pending
GET /api/memory/todos?filter=done
GET /api/memory/todos?filter=all
GET /api/memory/todos?filter=pending&category=work
```

**Response:**
```json
{ "raw": "id  title  description  status  due_date  ..." }
```

---

### 9. Create Todo

Add a new task.

```
POST /api/memory/todos
Content-Type: application/json
```

**Body:**
```json
{
  "title": "Task title (required)",
  "description": "Details (optional)",
  "due_date": "2026-08-15 (optional)",
  "due_time": "14:00 (optional)",
  "category": "work (optional)"
}
```

**Response:**
```json
{ "ok": true, "id": 10, "raw": "TODO_ADDED_ID=10" }
```

> Note: `id` field contains the actual inserted ID as a number.

---

### 10. Mark Todo Done

```
PATCH /api/memory/todos/:id/done
```

**Response (200):**
```json
{ "ok": true, "raw": "TODO_MARKED_DONE: 10" }
```

**Response (404):**
```json
{ "error": "todo not found", "id": "99999" }
```

---

### 11. Reopen Todo

```
PATCH /api/memory/todos/:id/undone
```

**Response (200):**
```json
{ "ok": true, "raw": "TODO_MARKED_UNDONE: 10" }
```

**Response (404):**
```json
{ "error": "todo not found", "id": "99999" }
```

---

### 12. Delete Todo

```
DELETE /api/memory/todos/:id
```

**Response (200):**
```json
{ "ok": true, "raw": "TODO_DELETED: 10" }
```

**Response (404):**
```json
{ "error": "todo not found", "id": "99999" }
```

---

## Quick Start Examples

### curl

```bash
# Set your token
TOKEN="your_token_here"
BASE="https://onebot.onetez.com"

# Read all memory
curl -H "Authorization: Bearer $TOKEN" $BASE/api/memory

# Read facts only
curl -H "Authorization: Bearer $TOKEN" $BASE/api/memory/facts

# Add a fact
curl -X POST $BASE/api/memory/facts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fact":"ImagixAI migrated to Postgres on 2026-08-05"}'

# Search journal
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/memory/journal?q=ImagixAI"

# Add journal entry
curl -X POST $BASE/api/memory/journal \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content":"Finished feature X","category":"work","tags":"feature,release"}'

# List pending todos
curl -H "Authorization: Bearer $TOKEN" $BASE/api/memory/todos

# Create a todo
curl -X POST $BASE/api/memory/todos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Review PR #42","due_date":"2026-08-15","category":"work"}'

# Mark todo done
curl -X PATCH -H "Authorization: Bearer $TOKEN" $BASE/api/memory/todos/10/done

# Reopen todo
curl -X PATCH -H "Authorization: Bearer $TOKEN" $BASE/api/memory/todos/10/undone

# Delete todo
curl -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/api/memory/todos/10

# Read single journal entry (full content)
curl -H "Authorization: Bearer $TOKEN" $BASE/api/memory/journal/22

# Delete journal entry
curl -X DELETE -H "Authorization: Bearer $TOKEN" $BASE/api/memory/journal/27
```

### Claude Code (CLAUDE.md instruction)

Add this to your project's `CLAUDE.md`:

```markdown
## Shared Memory
Before starting work, read shared memory for context:
- Run: curl -s -H "Authorization: Bearer $MEMORY_API_TOKEN" https://onebot.onetez.com/api/memory/facts
- After completing significant work, write a fact:
  curl -X POST https://onebot.onetez.com/api/memory/facts \
    -H "Authorization: Bearer $MEMORY_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"fact":"<what was done>"}'
```

## Architecture

```
AI Agents (read/write)          PHÈN DEV (central brain)
+------------------+            +---------------------------+
| Claude Code (Mac)|---API----->|                           |
| Codex            |---API----->|  Memory API               |
| Gemini           |---API----->|  https://onebot.onetez.com|
+------------------+            |         |                 |
                                |  MEMORY.md (L3/L2/L1)    |
                                |  SQLite DB (journal,todos)|
                                |         |                 |
                                |  Weekly Distill           |
                                |  (Sun 8AM cron)           |
                                +---------------------------+
```

PHÈN DEV runs 24/7 and acts as the single source of truth. It distills journal entries into L1 facts every Sunday at 8AM.
