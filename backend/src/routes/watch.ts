import { Router } from "express";
import { db } from "../db.js";
import { runWatch, isWatchRunning } from "../watch.js";
import { getState } from "../state.js";
import { prepareCandidature } from "../actions.js";

export const watchRouter = Router();

// interested = swiped right, dismissed = left, urgent = up (act today).
const STATUSES = ["new", "seen", "interested", "dismissed", "urgent"];

// Items seen in the last 30 days (starred ones always), best first.
watchRouter.get("/items", (_req, res) => {
  res.json(
    db
      .prepare(
        `SELECT i.*, s.name AS source_name FROM watch_items i LEFT JOIN watch_sources s ON s.id = i.source_id
         WHERE i.status = 'interested' OR i.last_seen_at >= datetime('now', '-30 days')
         ORDER BY (i.status = 'dismissed'), i.score DESC, i.first_seen_at DESC`
      )
      .all()
  );
});

watchRouter.post("/items/:id/status", (req, res) => {
  const status = String(req.body?.status ?? "");
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "Statut invalide." });
  db.prepare("UPDATE watch_items SET status = ? WHERE id = ?").run(status, req.params.id);
  // Swipe up: act today. Offers get their application prepared right away
  // (plus a task and an afternoon nudge), anything else becomes a task.
  if (status === "urgent") {
    const item = db.prepare("SELECT id, category, title, company FROM watch_items WHERE id = ?").get(req.params.id) as
      | { id: number; category: string; title: string; company: string | null }
      | undefined;
    if (item && ["stage", "alternance", "emploi"].includes(item.category)) {
      prepareCandidature(item.id, true).catch((err) => console.error("Candidature urgente :", err));
    } else if (item) {
      db.prepare("INSERT INTO todos (title) VALUES (?)").run(`${item.title}${item.company ? ` (${item.company})` : ""}`);
    }
  }
  res.json({ ok: true });
});

// Marks every "new" item as seen once the list has been looked at.
watchRouter.post("/items/mark-seen", (_req, res) => {
  db.prepare("UPDATE watch_items SET status = 'seen' WHERE status = 'new'").run();
  res.json({ ok: true });
});

watchRouter.get("/sources", (_req, res) => {
  res.json(db.prepare("SELECT id, name, url, kind, enabled, last_checked_at, last_error FROM watch_sources ORDER BY id").all());
});

watchRouter.post("/sources", (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const url = String(req.body?.url ?? "").trim();
  if (!name || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Nom et adresse (https://...) requis." });
  const kind = /\.myworkdayjobs\.com\//.test(url) ? "workday" : "page";
  try {
    const result = db.prepare("INSERT INTO watch_sources (name, url, kind) VALUES (?, ?, ?)").run(name, url, kind);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch {
    res.status(409).json({ error: "Cette adresse est déjà surveillée." });
  }
});

watchRouter.delete("/sources/:id", (req, res) => {
  db.prepare("DELETE FROM watch_sources WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

watchRouter.get("/queries", (_req, res) => {
  res.json(db.prepare("SELECT id, query, enabled, last_run_at, last_error FROM watch_queries ORDER BY id").all());
});

watchRouter.post("/queries", (req, res) => {
  const query = String(req.body?.query ?? "").trim();
  if (!query) return res.status(400).json({ error: "Requête requise." });
  try {
    const result = db.prepare("INSERT INTO watch_queries (query) VALUES (?)").run(query);
    res.status(201).json({ id: result.lastInsertRowid });
  } catch {
    res.status(409).json({ error: "Cette requête existe déjà." });
  }
});

watchRouter.delete("/queries/:id", (req, res) => {
  db.prepare("DELETE FROM watch_queries WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

watchRouter.get("/status", (_req, res) => {
  res.json({ running: isWatchRunning(), lastRun: getState("watch_last_run") ?? null });
});

// Manual run from the app. Returns right away, the app polls /status.
watchRouter.post("/run", (_req, res) => {
  if (!isWatchRunning()) runWatch().catch((err) => console.error("Veille :", err));
  res.json({ running: true });
});
