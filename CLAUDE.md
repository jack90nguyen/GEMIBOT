# CLAUDE.md

## 1. Think Before Coding
**Don't assume. Don't hide confusion. Surface tradeoffs.**
- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them.
- Prefer simpler solutions.
- If unclear, stop and clarify.

## 2. Simplicity & Conventions
**Minimum code that solves the problem. Nothing speculative.**
- Build only what was requested.
- No YAGNI: no speculative features or abstractions.
- Follow existing patterns.
- Use short clear names and verb-based functions.
- If overengineered, simplify.

## 3. Data & Safety Rules
- Do not use `any` (TS) or `dynamic` (C#).
- Public APIs / services must return explicit models.
- Check for manual user edits before changes.
- Never overwrite user changes without confirmation.
- Keep diffs minimal and preserve logic.

## 4. Workflow & Output
- Before adding / editing / deleting any file or code: MUST analyze the request, present a plan to the user, and wait for the user's approval before executing. Never modify files immediately.
- Read-only actions (reading files, grep, ls, git status, etc.) used to understand the request: do them directly, no plan needed.
- Report briefly: What changed, Why, Check result
- Never claim completion before checks pass.
