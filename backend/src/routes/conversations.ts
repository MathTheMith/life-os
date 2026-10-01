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

conversationsRouter.get("/", (_req, res) => {
  res.json(db.prepare("SELECT id, title, kind, created_at, updated_at FROM conversations ORDER BY updated_at DESC").all());
});

// Images live on disk, not in the database — the ON DELETE CASCADE on
// conversation_messages drops the rows for free, but the files would be
// left as orphans otherwise. Shared by the manual delete route below and
// brief.ts's automatic cleanup of stale "Question du jour" conversations.
export function deleteConversationById(id: number) {
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

  const date = parisNow().date;
  const existing = db
    .prepare("SELECT id, title FROM conversations WHERE kind = 'question' AND question_date = ?")
    .get(date) as { id: number; title: string } | undefined;
  if (existing) return res.json(existing);

  const title = "Question du jour";
  const create = db.transaction(() => {
    const id = Number(
      db.prepare("INSERT INTO conversations (title, kind, question_date) VALUES (?, 'question', ?)").run(title, date)
        .lastInsertRowid
    );
    db.prepare("INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(
      id,
      question.trim()
    );
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
  deleteConversationById(Number(req.params.id));
  res.json({ ok: true });
});
