import { Router } from "express";
import { db } from "../db.js";

// Fed by the Android launcher widget (needs OS-level "usage access", granted
// once from its settings) — one row per day, overwritten as the day's
// running total grows so it's always the latest snapshot, never a pile of
// partial-day duplicates. Not just a readout: exposed to the chat and the
// evening review so the AI can actually weigh it in, not just display it.
db.exec(`
  CREATE TABLE IF NOT EXISTS phone_usage (
    date TEXT PRIMARY KEY,
    total_minutes INTEGER NOT NULL,
    apps_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export const phoneRouter = Router();

interface AppUsage {
  name: string;
  minutes: number;
}

phoneRouter.post("/screen-time", (req, res) => {
  const { date, totalMinutes, apps } = req.body as { date?: string; totalMinutes?: number; apps?: AppUsage[] };
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof totalMinutes !== "number" || !Number.isFinite(totalMinutes)) {
    return res.status(400).json({ error: "date (AAAA-MM-JJ) et totalMinutes requis." });
  }
  const cleanApps = Array.isArray(apps)
    ? apps
        .filter((a) => a && typeof a.name === "string" && typeof a.minutes === "number")
        .map((a) => ({ name: a.name, minutes: Math.round(a.minutes) }))
        .slice(0, 15)
    : [];
  db.prepare(
    `INSERT INTO phone_usage (date, total_minutes, apps_json, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(date) DO UPDATE SET total_minutes = excluded.total_minutes, apps_json = excluded.apps_json, updated_at = datetime('now')`
  ).run(date, Math.round(totalMinutes), JSON.stringify(cleanApps));
  res.json({ ok: true });
});

function formatRow(r: { date: string; total_minutes: number; apps_json: string | null }): string {
  const apps = r.apps_json ? (JSON.parse(r.apps_json) as AppUsage[]) : [];
  const top = apps
    .slice(0, 3)
    .map((a) => `${a.name} ${a.minutes}min`)
    .join(", ");
  const h = Math.floor(r.total_minutes / 60);
  const m = r.total_minutes % 60;
  return `${r.date} : ${h}h${String(m).padStart(2, "0")} au total${top ? ` (top : ${top})` : ""}`;
}

// For the main chat's system prompt: the trend over the last few days.
export function getPhoneUsageForPrompt(days = 7): string {
  const rows = db
    .prepare("SELECT date, total_minutes, apps_json FROM phone_usage WHERE date >= date('now', ?) ORDER BY date DESC")
    .all(`-${days} days`) as { date: string; total_minutes: number; apps_json: string | null }[];
  return rows.map((r) => `- ${formatRow(r)}`).join("\n");
}

// For the evening review's "what was planned vs. what happened" evidence:
// just that one day, so a claimed-productive evening can be weighed against
// how much of it actually went into the phone.
export function getPhoneUsageForDate(date: string): string {
  const row = db.prepare("SELECT date, total_minutes, apps_json FROM phone_usage WHERE date = ?").get(date) as
    | { date: string; total_minutes: number; apps_json: string | null }
    | undefined;
  return row ? formatRow(row) : "(pas de données)";
}
