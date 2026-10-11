import { Router } from "express";
import { db } from "../db.js";

// Sim racing laps pushed by acc-telemetry (github.com/MathTheMith/acc-telemetry)
// from the PC running ACC. Deliberately just the result of each lap — track,
// car, time, valid or not (an invalid lap had a track-limits cut or another
// mistake, so its time doesn't really count) — no telemetry trace. That's
// enough for the chat to follow pace and consistency over time.
db.exec(`
  CREATE TABLE IF NOT EXISTS sim_laps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    track TEXT NOT NULL,
    car TEXT NOT NULL,
    lap_time_ms INTEGER NOT NULL,
    valid INTEGER NOT NULL,
    driven_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sim_laps_track_car ON sim_laps (track, car, driven_at);
`);

export const simLapsRouter = Router();

interface IncomingLap {
  uid?: string;
  track?: string;
  car?: string;
  lapTimeMs?: number;
  valid?: boolean;
  drivenAt?: string;
}

const MAX_LAPS_PER_REQUEST = 5000;

// Batch insert, idempotent on uid ("<session folder>/<lap number>"), so the
// one-off import of old sessions can be re-run safely.
simLapsRouter.post("/", (req, res) => {
  const laps = (req.body as { laps?: IncomingLap[] }).laps;
  if (!Array.isArray(laps) || laps.length === 0 || laps.length > MAX_LAPS_PER_REQUEST) {
    return res.status(400).json({ error: `laps : tableau de 1 à ${MAX_LAPS_PER_REQUEST} tours requis.` });
  }
  const clean = laps.filter(
    (l) =>
      l &&
      typeof l.uid === "string" && l.uid.length > 0 && l.uid.length <= 200 &&
      typeof l.track === "string" && l.track.length > 0 && l.track.length <= 100 &&
      typeof l.car === "string" && l.car.length > 0 && l.car.length <= 100 &&
      typeof l.lapTimeMs === "number" && Number.isFinite(l.lapTimeMs) && l.lapTimeMs > 0 && l.lapTimeMs < 3_600_000 &&
      typeof l.valid === "boolean" &&
      typeof l.drivenAt === "string" && !Number.isNaN(Date.parse(l.drivenAt))
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO sim_laps (uid, track, car, lap_time_ms, valid, driven_at) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const inserted = db.transaction(() => {
    let n = 0;
    for (const l of clean) {
      n += insert.run(l.uid, l.track, l.car, Math.round(l.lapTimeMs!), l.valid ? 1 : 0, new Date(l.drivenAt!).toISOString()).changes;
    }
    return n;
  })();
  res.json({ received: laps.length, inserted, rejected: laps.length - clean.length });
});

function formatLapTime(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms - minutes * 60000) / 1000;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

// "AAAA-MM-JJ HH:MM", Paris time (stored as UTC).
const parisTime = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 16);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

interface LapRow {
  track: string;
  car: string;
  lap_time_ms: number;
  valid: number;
  driven_at: string;
}

// For the chat: one block per track + car with best/median/consistency, plus
// the most recent laps in order, times already formatted so the model
// doesn't have to convert milliseconds.
export function getSimLapsSummary(filters: { track?: string; car?: string; days?: number }) {
  const days = Math.min(Math.max(Number(filters.days) || 90, 1), 3650);
  const conditions = ["driven_at >= ?"];
  const params: unknown[] = [new Date(Date.now() - days * 86_400_000).toISOString()];
  if (filters.track) {
    conditions.push("track LIKE ?");
    params.push(`%${filters.track}%`);
  }
  if (filters.car) {
    conditions.push("car LIKE ?");
    params.push(`%${filters.car}%`);
  }
  const rows = db
    .prepare(`SELECT track, car, lap_time_ms, valid, driven_at FROM sim_laps WHERE ${conditions.join(" AND ")} ORDER BY driven_at ASC, id ASC`)
    .all(...params) as LapRow[];

  const groups = new Map<string, LapRow[]>();
  for (const r of rows) {
    const key = `${r.track}\u0000${r.car}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  const combos = [...groups.values()].map((laps) => {
    const valid = laps.filter((l) => l.valid);
    const validTimes = valid.map((l) => l.lap_time_ms);
    const best = validTimes.length ? Math.min(...validTimes) : null;
    const last10 = validTimes.slice(-10);
    const med = median(last10);
    return {
      track: laps[0].track,
      car: laps[0].car,
      laps: laps.length,
      valid_laps: valid.length,
      invalid_laps: laps.length - valid.length,
      best_valid: best !== null ? formatLapTime(best) : null,
      median_last_10_valid: med !== null ? formatLapTime(med) : null,
      // How far the typical recent lap is from the best one: the consistency gap.
      median_last_10_gap_to_best_s: best !== null && med !== null ? +((med - best) / 1000).toFixed(3) : null,
      first_driven: parisTime(laps[0].driven_at).slice(0, 10),
      last_driven: parisTime(laps[laps.length - 1].driven_at).slice(0, 10),
      recent_laps: laps.slice(-40).map((l) => ({
        when: parisTime(l.driven_at),
        time: formatLapTime(l.lap_time_ms),
        valid: Boolean(l.valid),
      })),
    };
  });
  combos.sort((a, b) => b.last_driven.localeCompare(a.last_driven));
  return { period_days: days, total_laps: rows.length, combos };
}
