import { Router } from "express";
import { db } from "../db.js";

export const todosRouter = Router();

todosRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM todos ORDER BY done ASC, created_at DESC").all() as { done: number }[];
  res.json(rows.map((r) => ({ ...r, done: !!r.done })));
});

todosRouter.post("/", (req, res) => {
  const { title } = req.body as { title?: string };
  if (!title) return res.status(400).json({ error: "title requis" });
  const result = db.prepare("INSERT INTO todos (title) VALUES (?)").run(title);
  res.json({ id: result.lastInsertRowid });
});

todosRouter.patch("/:id", (req, res) => {
  const { done, title } = req.body as { done?: boolean; title?: string };
  const current = db.prepare("SELECT done FROM todos WHERE id = ?").get(req.params.id) as
    | { done: number }
    | undefined;
  if (!current) return res.status(404).json({ error: "Tâche introuvable." });

  const finalDone = done === undefined ? current.done === 1 : done;
  const completedAt = finalDone ? new Date().toISOString().slice(0, 10) : null;

  db.prepare("UPDATE todos SET title = COALESCE(?, title), done = ?, completed_at = ? WHERE id = ?").run(
    title ?? null,
    finalDone ? 1 : 0,
    completedAt,
    req.params.id
  );
  res.json({ ok: true });
});

// Dedicated toggle endpoint (in addition to PATCH) because Android's
// HttpURLConnection — used by the launcher widget — can't issue PATCH
// requests (not in its allowed method list), only GET/POST/DELETE.
todosRouter.post("/:id/toggle", (req, res) => {
  const current = db.prepare("SELECT done FROM todos WHERE id = ?").get(req.params.id) as
    | { done: number }
    | undefined;
  if (!current) return res.status(404).json({ error: "Tâche introuvable." });

  const finalDone = current.done === 0;
  const completedAt = finalDone ? new Date().toISOString().slice(0, 10) : null;
  db.prepare("UPDATE todos SET done = ?, completed_at = ? WHERE id = ?").run(
    finalDone ? 1 : 0,
    completedAt,
    req.params.id
  );
  res.json({ ok: true, done: finalDone });
});

todosRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM todos WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
