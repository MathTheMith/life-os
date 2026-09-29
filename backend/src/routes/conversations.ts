import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { db, uploadsDir } from "../db.js";

export const conversationsRouter = Router();

conversationsRouter.get("/", (_req, res) => {
  res.json(db.prepare("SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC").all());
});

conversationsRouter.post("/", (req, res) => {
  const { title } = req.body as { title?: string };
  const result = db
    .prepare("INSERT INTO conversations (title) VALUES (?)")
    .run(title?.trim() || "Nouvelle conversation");
  res.json({ id: result.lastInsertRowid });
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
  // Images live on disk, not in the database — the ON DELETE CASCADE on
  // conversation_messages drops the rows for free, but the files would be
  // left as orphans otherwise.
  const imagePaths = db
    .prepare("SELECT image_path FROM conversation_messages WHERE conversation_id = ? AND image_path IS NOT NULL")
    .all(req.params.id) as { image_path: string }[];
  db.prepare("DELETE FROM conversations WHERE id = ?").run(req.params.id);
  for (const { image_path } of imagePaths) {
    fs.rm(path.join(uploadsDir, path.basename(image_path)), () => {});
  }
  res.json({ ok: true });
});
