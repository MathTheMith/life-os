import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { db, uploadsDir } from "../db.js";
import { parisNow } from "../state.js";

export const conversationsRouter = Router();

// question_date: which day's "Question du jour" this is, the same way
// journal_date ties the evening chat to a day (see journal.ts) — lets
// POST /question reuse today's conversation instead of starting a new one
// every time "Répondre" is tapped, and lets brief.ts prune yesterday's once
// a new question exists (see runBrief in brief.ts). Everything worth
// keeping from it is already forced into the profile/notes during the chat
// itself (chat.ts's 'question' mode), so the raw transcript is disposable.
if (!(db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).some((c) => c.name === "question_date")) {
  db.exec("ALTER TABLE conversations ADD COLUMN question_date TEXT");
}

// Tracks the question this "Question du jour" chat is currently waiting an
// answer for, and whether that one's been answered yet — the brief can be
// regenerated later the same day with a new question, and this is what
// lets POST /question tell "swap the still-unanswered one in place" apart
// from "he already answered that, this is a genuinely new one, append it".
if (!(db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).some((c) => c.name === "current_question")) {
  db.exec("ALTER TABLE conversations ADD COLUMN current_question TEXT");
  db.exec("ALTER TABLE conversations ADD COLUMN current_question_answered INTEGER NOT NULL DEFAULT 0");
  // Backfill from whatever's already there, so existing question-chats
  // don't all read as "unanswered" the first time this runs (which would
  // let a stale one get silently overwritten instead of a new question
  // being appended). The exact backfilled text barely matters — only that
  // "answered" reflects reality and the text won't coincidentally match a
  // real future question.
  for (const { id } of db.prepare("SELECT id FROM conversations WHERE kind = 'question'").all() as { id: number }[]) {
    const lastAssistant = db
      .prepare("SELECT content FROM conversation_messages WHERE conversation_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1")
      .get(id) as { content: string } | undefined;
    const hasReply = db.prepare("SELECT 1 FROM conversation_messages WHERE conversation_id = ? AND role = 'user' LIMIT 1").get(id);
    db.prepare("UPDATE conversations SET current_question = ?, current_question_answered = ? WHERE id = ?").run(
      lastAssistant?.content ?? null,
      hasReply ? 1 : 0,
      id
    );
  }
}

// A protected conversation (e.g. a main, ongoing chat Mathéo wants to keep
// around for good) can't be deleted — from this app or by mistake — unlike
// the disposable kinds (question/evening chats) that get pruned once stale.
if (!(db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).some((c) => c.name === "protected")) {
  db.exec("ALTER TABLE conversations ADD COLUMN protected INTEGER NOT NULL DEFAULT 0");
}

conversationsRouter.get("/", (_req, res) => {
  const rows = db
    .prepare("SELECT id, title, kind, protected, created_at, updated_at FROM conversations ORDER BY updated_at DESC")
    .all() as { protected: number }[];
  res.json(rows.map((r) => ({ ...r, protected: !!r.protected })));
});

// Images live on disk, not in the database — the ON DELETE CASCADE on
// conversation_messages drops the rows for free, but the files would be
// left as orphans otherwise. Shared by the manual delete route below and
// brief.ts's automatic cleanup of stale "Question du jour" conversations.
export function deleteConversationById(id: number) {
  const row = db.prepare("SELECT protected FROM conversations WHERE id = ?").get(id) as { protected: number } | undefined;
  if (!row || row.protected) return;
  const imagePaths = db
    .prepare("SELECT image_path FROM conversation_messages WHERE conversation_id = ? AND image_path IS NOT NULL")
    .all(id) as { image_path: string }[];
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  for (const { image_path } of imagePaths) {
    fs.rm(path.join(uploadsDir, path.basename(image_path)), () => {});
  }
}

// assistantMessage: opens the conversation with a message from the AI, used
// for one-off AI-started chats. For the daily question specifically, use
// POST /question below instead — it needs the get-or-create-for-today
// behavior, not a new conversation on every call.
const ALLOWED_KINDS = new Set(["normal", "question"]);

conversationsRouter.post("/", (req, res) => {
  const { title, assistantMessage, kind } = req.body as { title?: string; assistantMessage?: string; kind?: string };
  const safeKind = kind && ALLOWED_KINDS.has(kind) ? kind : "normal";
  const result = db
    .prepare("INSERT INTO conversations (title, kind) VALUES (?, ?)")
    .run(title?.trim() || "Nouvelle conversation", safeKind);
  if (assistantMessage?.trim()) {
    db.prepare("INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(
      result.lastInsertRowid,
      assistantMessage.trim()
    );
  }
  res.json({ id: result.lastInsertRowid });
});

// Opens today's "Question du jour" chat, creating it (with the AI's
// question as the opening message) the first time. Tapping "Répondre"
// again the same day — even after closing the chat — continues that same
// conversation instead of asking the question again from scratch.
conversationsRouter.post("/question", (req, res) => {
  const { question } = req.body as { question?: string };
  if (!question?.trim()) return res.status(400).json({ error: "question requise" });
  const q = question.trim();

  const date = parisNow().date;
  const existing = db
    .prepare("SELECT id, title, current_question, current_question_answered FROM conversations WHERE kind = 'question' AND question_date = ?")
    .get(date) as { id: number; title: string; current_question: string | null; current_question_answered: number } | undefined;

  if (existing) {
    // The brief (and its question) can be regenerated later the same day.
    // Already in sync (whether answered or not) — nothing to do.
    if (existing.current_question !== q) {
      if (!existing.current_question_answered) {
        // Still waiting on the previous one — nothing lost by swapping it
        // in place instead of asking twice.
        db.prepare("UPDATE conversation_messages SET content = ? WHERE conversation_id = ? AND role = 'assistant' AND content = ?").run(
          q,
          existing.id,
          existing.current_question
        );
      } else {
        // That one's already answered and closed — this is a genuinely new
        // question, appended so the thread keeps its history instead of
        // reopening on an old, settled exchange.
        db.prepare("INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(existing.id, q);
      }
      db.prepare("UPDATE conversations SET current_question = ?, current_question_answered = 0 WHERE id = ?").run(q, existing.id);
    }
    return res.json(existing);
  }

  const title = "Question du jour";
  const create = db.transaction(() => {
    const id = Number(
      db
        .prepare("INSERT INTO conversations (title, kind, question_date, current_question) VALUES (?, 'question', ?, ?)")
        .run(title, date, q).lastInsertRowid
    );
    db.prepare("INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(id, q);
    return id;
  });
  res.json({ id: create(), title });
});

conversationsRouter.get("/:id/messages", (req, res) => {
  const conversation = db.prepare("SELECT id FROM conversations WHERE id = ?").get(req.params.id);
  if (!conversation) return res.status(404).json({ error: "Conversation introuvable." });
  res.json(
    db
      .prepare(
        "SELECT id, role, content, image_path AS image, created_at FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC"
      )
      .all(req.params.id)
  );
});

conversationsRouter.patch("/:id", (req, res) => {
  const { title } = req.body as { title?: string };
  if (!title) return res.status(400).json({ error: "title requis" });
  db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title.trim(), req.params.id);
  res.json({ ok: true });
});

conversationsRouter.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT protected FROM conversations WHERE id = ?").get(req.params.id) as { protected: number } | undefined;
  if (row?.protected) return res.status(400).json({ error: "Cette conversation est protégée, elle ne peut pas être supprimée." });
  deleteConversationById(Number(req.params.id));
  res.json({ ok: true });
});
