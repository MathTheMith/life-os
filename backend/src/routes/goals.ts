import { Router } from "express";
import { db } from "../db.js";

export const goalsRouter = Router();

function computeStreak(dates: string[]): number {
  // dates: distinct check-in dates for one goal, any order.
  const set = new Set(dates);
  let streak = 0;
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  // Current streak: consecutive days ending today. If today has no check-in
  // yet, the streak is 0 rather than "still alive from yesterday" — simpler
  // to reason about, and it nudges you to check in today to keep it going.
  while (true) {
    const iso = cursor.toISOString().slice(0, 10);
    if (!set.has(iso)) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function computeLast7Days(dates: string[]): boolean[] {
  // Oldest to newest, today last — a week-at-a-glance strip reads more like
  // a daily habit than a single streak number does.
  const set = new Set(dates);
  const days: boolean[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - 6);
  for (let i = 0; i < 7; i++) {
    days.push(set.has(cursor.toISOString().slice(0, 10)));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function listGoalsWithStats() {
  const goals = db
    .prepare(
      "SELECT * FROM goals ORDER BY status = 'fait', target_date IS NULL, target_date ASC, created_at DESC"
    )
    .all() as { id: number; kind: string }[];

  const allCheckins = db.prepare("SELECT goal_id, date FROM goal_checkins").all() as {
    goal_id: number;
    date: string;
  }[];
  const byGoal = new Map<number, string[]>();
  for (const c of allCheckins) {
    const arr = byGoal.get(c.goal_id) ?? [];
    arr.push(c.date);
    byGoal.set(c.goal_id, arr);
  }

  const today = new Date().toISOString().slice(0, 10);

  return goals.map((g) => {
    const dates = byGoal.get(g.id) ?? [];
    return {
      ...g,
      checkinCount: dates.length,
      lastCheckin: dates.length ? dates.sort().at(-1) : null,
      checkedInToday: dates.includes(today),
      streak: g.kind === "recurrent" ? computeStreak(dates) : 0,
      last7Days: g.kind === "recurrent" ? computeLast7Days(dates) : [],
    };
  });
}

goalsRouter.get("/", (_req, res) => {
  res.json(listGoalsWithStats());
});

goalsRouter.post("/", (req, res) => {
  const { title, description, kind, targetDate } = req.body as {
    title?: string;
    description?: string;
    kind?: "unique" | "recurrent";
    targetDate?: string;
  };

  if (!title) return res.status(400).json({ error: "title requis" });

  const result = db
    .prepare(
      "INSERT INTO goals (title, description, kind, target_date, status) VALUES (?, ?, ?, ?, ?)"
    )
    .run(title, description || null, kind || "unique", targetDate || null, "a_faire");

  res.json({ id: result.lastInsertRowid });
});

goalsRouter.patch("/:id", (req, res) => {
  const { status, title, description, targetDate } = req.body as {
    status?: string;
    title?: string;
    description?: string;
    targetDate?: string;
  };

  const completedAt = status === "fait" ? new Date().toISOString().slice(0, 10) : null;

  db.prepare(
    `UPDATE goals SET
       status = COALESCE(?, status),
       title = COALESCE(?, title),
       description = COALESCE(?, description),
       target_date = COALESCE(?, target_date),
       completed_at = CASE WHEN ? = 'fait' THEN ? ELSE completed_at END
     WHERE id = ?`
  ).run(status ?? null, title ?? null, description ?? null, targetDate ?? null, status ?? "", completedAt, req.params.id);

  res.json({ ok: true });
});

goalsRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM goals WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

goalsRouter.post("/:id/checkins", (req, res) => {
  const { date, note } = req.body as { date?: string; note?: string };
  const finalDate = date || new Date().toISOString().slice(0, 10);

  const goal = db.prepare("SELECT id FROM goals WHERE id = ?").get(req.params.id);
  if (!goal) return res.status(404).json({ error: "Objectif introuvable" });

  // Idempotent per day: tapping "fait aujourd'hui" twice shouldn't inflate
  // the count or streak.
  const existing = db
    .prepare("SELECT id FROM goal_checkins WHERE goal_id = ? AND date = ?")
    .get(req.params.id, finalDate);
  if (existing) return res.json({ id: (existing as { id: number }).id, already: true });

  const result = db
    .prepare("INSERT INTO goal_checkins (goal_id, date, note) VALUES (?, ?, ?)")
    .run(req.params.id, finalDate, note || null);

  res.json({ id: result.lastInsertRowid });
});

goalsRouter.delete("/:id/checkins/:date", (req, res) => {
  db.prepare("DELETE FROM goal_checkins WHERE goal_id = ? AND date = ?").run(
    req.params.id,
    req.params.date
  );
  res.json({ ok: true });
});

goalsRouter.get("/:id/checkins", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM goal_checkins WHERE goal_id = ? ORDER BY date DESC")
    .all(req.params.id);
  res.json(rows);
});
