import { Router } from "express";
import { db } from "../db.js";

// The user's agenda, kept by the AI: it adds events it spots in mails, in
// the evening chat or when asked in the chat, and the user can edit them.
// Times are Paris wall-clock strings ("2026-10-05T14:00", or "2026-10-05"
// for all-day events). Each event has any number of reminders (offsets in
// minutes before the start, e.g. a week, a day and an hour before), stored
// with their UTC instant for the reminder job in reminders.ts.

db.exec(`
  CREATE TABLE IF NOT EXISTS agenda_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    remind_before_min INTEGER, -- legacy single reminder, see the migration below
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agenda_start ON agenda_events(start_at);

  CREATE TABLE IF NOT EXISTS agenda_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES agenda_events(id) ON DELETE CASCADE,
    offset_min INTEGER NOT NULL,
    remind_at TEXT NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    UNIQUE (event_id, offset_min)
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON agenda_reminders(sent, remind_at);
`);

export type AgendaSource = "user" | "chat" | "journal" | "mail";

export interface AgendaEvent {
  id: number;
  title: string;
  start_at: string;
  end_at: string | null;
  all_day: number;
  notes: string | null;
  source: AgendaSource;
  // Offsets in minutes before the start, from the reminders table.
  reminders: number[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
// Used when neither the user nor the AI picked reminders: the day before
// and an hour before (for an all-day event: the day before and that morning).
export const DEFAULT_REMINDERS_MIN = [1440, 60];
const DEFAULT_ALL_DAY_REMINDERS_MIN = [1440, 0];
// All-day events count their reminders back from this time on the day.
const ALL_DAY_BASE_TIME = "09:00";

// Paris wall-clock "YYYY-MM-DDTHH:MM" to a UTC Date, DST-aware without a
// timezone library: take the naive UTC guess, measure Paris' offset at that
// instant, subtract it.
export function parisToUtc(local: string): Date {
  const [d, t = "00:00"] = local.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(guess))
      .map((p) => [p.type, p.value])
  );
  const asParis = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(guess - (asParis - guess));
}

// Current Paris wall-clock time as "YYYY-MM-DDTHH:MM".
export function parisNowLocal(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date())
    .replace(" ", "T");
}

function eventBaseUtc(startAt: string, allDay: boolean): Date {
  return parisToUtc(allDay ? `${startAt}T${ALL_DAY_BASE_TIME}` : startAt);
}

// Replaces the event's pending reminders. Offsets whose time has already
// passed are dropped (no "one week before" for an event tomorrow).
function setReminders(eventId: number, startAt: string, allDay: boolean, offsets: number[]) {
  const base = eventBaseUtc(startAt, allDay).getTime();
  const now = Date.now();
  db.prepare("DELETE FROM agenda_reminders WHERE event_id = ? AND sent = 0").run(eventId);
  const insert = db.prepare("INSERT OR IGNORE INTO agenda_reminders (event_id, offset_min, remind_at) VALUES (?, ?, ?)");
  let pending = 0;
  for (const offset of new Set(offsets)) {
    const at = base - offset * 60 * 1000;
    if (at > now) pending += insert.run(eventId, offset, new Date(at).toISOString()).changes;
  }

  // An appointment learned about late (a mail about a meeting in 20 min)
  // has all its reminders in the past: notify right away instead of never.
  // Skipped when the user chose no reminders, for all-day events, and when
  // this event already got a reminder (an edit shouldn't notify again).
  const alreadySent = db.prepare("SELECT 1 FROM agenda_reminders WHERE event_id = ? AND sent = 1").get(eventId);
  if (offsets.length > 0 && pending === 0 && !allDay && base > now && !alreadySent) {
    insert.run(eventId, Math.max(1, Math.round((base - now) / 60000)), new Date(now).toISOString());
  }
}

function parseReminders(input: EventInput, allDay: boolean): number[] {
  if (Array.isArray(input.reminders_min)) {
    return input.reminders_min.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 60);
  }
  // Older single-reminder field, still accepted.
  if (input.remind_before_min === null) return [];
  if (input.remind_before_min !== undefined && Number.isFinite(Number(input.remind_before_min))) {
    return [Number(input.remind_before_min)];
  }
  return allDay ? DEFAULT_ALL_DAY_REMINDERS_MIN : DEFAULT_REMINDERS_MIN;
}

export interface EventInput {
  title: string;
  start: string;
  end?: string | null;
  all_day?: boolean;
  notes?: string | null;
  reminders_min?: number[];
  remind_before_min?: number | null;
  source?: AgendaSource;
}

function normalize(input: EventInput) {
  const title = String(input.title ?? "").trim();
  const start = String(input.start ?? "").trim();
  if (!title) throw new Error("Titre requis.");
  const allDay = input.all_day === true || DATE_RE.test(start);
  if (allDay ? !DATE_RE.test(start.slice(0, 10)) : !DATE_TIME_RE.test(start)) {
    throw new Error("Date invalide : attendu AAAA-MM-JJ ou AAAA-MM-JJTHH:MM (heure de Paris).");
  }
  const startAt = allDay ? start.slice(0, 10) : start;
  const end = input.end && (DATE_RE.test(input.end) || DATE_TIME_RE.test(input.end)) ? input.end : null;
  return { title, startAt, end, allDay, notes: input.notes ? String(input.notes) : null, reminders: parseReminders(input, allDay) };
}

// Adds an event, or returns the existing one when the same title is already
// on the same day (the AI can spot one appointment in a mail and again in
// the evening chat).
export function addEvent(input: EventInput): { event: AgendaEvent; created: boolean } {
  const e = normalize(input);
  const existing = db
    .prepare("SELECT * FROM agenda_events WHERE lower(title) = lower(?) AND substr(start_at, 1, 10) = ?")
    .get(e.title, e.startAt.slice(0, 10)) as AgendaEvent | undefined;
  if (existing) return { event: existing, created: false };

  const result = db
    .prepare("INSERT INTO agenda_events (title, start_at, end_at, all_day, notes, source) VALUES (?, ?, ?, ?, ?, ?)")
    .run(e.title, e.startAt, e.end, e.allDay ? 1 : 0, e.notes, input.source ?? "user");
  const id = Number(result.lastInsertRowid);
  setReminders(id, e.startAt, e.allDay, e.reminders);
  return { event: getEvent(id)!, created: true };
}

export function updateEvent(id: number, input: EventInput): AgendaEvent | undefined {
  const e = normalize(input);
  const result = db
    .prepare("UPDATE agenda_events SET title = ?, start_at = ?, end_at = ?, all_day = ?, notes = ? WHERE id = ?")
    .run(e.title, e.startAt, e.end, e.allDay ? 1 : 0, e.notes, id);
  if (result.changes === 0) return undefined;
  setReminders(id, e.startAt, e.allDay, e.reminders);
  return getEvent(id);
}

export function deleteEvent(id: number) {
  db.prepare("DELETE FROM agenda_events WHERE id = ?").run(id);
}

const EVENT_COLUMNS = `e.id, e.title, e.start_at, e.end_at, e.all_day, e.notes, e.source,
  (SELECT json_group_array(offset_min) FROM (SELECT offset_min FROM agenda_reminders r WHERE r.event_id = e.id ORDER BY offset_min DESC)) AS reminders`;

function withReminders(row: any): AgendaEvent {
  return { ...row, reminders: JSON.parse(row.reminders ?? "[]") };
}

export function getEvent(id: number) {
  const row = db.prepare(`SELECT ${EVENT_COLUMNS} FROM agenda_events e WHERE e.id = ?`).get(id);
  return row ? withReminders(row) : undefined;
}

// Events whose start day is between from and to (inclusive, "YYYY-MM-DD").
export function listAgenda(from: string, to: string): AgendaEvent[] {
  return db
    .prepare(`SELECT ${EVENT_COLUMNS} FROM agenda_events e WHERE substr(e.start_at, 1, 10) BETWEEN ? AND ? ORDER BY e.start_at`)
    .all(from, to)
    .map(withReminders);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getAgendaForPrompt(days = 21): string {
  const today = parisNowLocal().slice(0, 10);
  return listAgenda(today, addDays(today, days))
    .map(
      (e) =>
        `- [id ${e.id}] ${e.all_day ? e.start_at : e.start_at.replace("T", " ")} : ${e.title}${e.notes ? ` (${e.notes})` : ""}` +
        ` [rappels : ${e.reminders.length ? e.reminders.join(", ") + " min avant" : "aucun"}]`
    )
    .join("\n");
}

// Events created before multiple reminders existed get the default ones.
for (const row of db
  .prepare(
    `SELECT id, start_at, all_day, remind_before_min FROM agenda_events e
     WHERE NOT EXISTS (SELECT 1 FROM agenda_reminders r WHERE r.event_id = e.id)`
  )
  .all() as { id: number; start_at: string; all_day: number; remind_before_min: number | null }[]) {
  const offsets = row.all_day ? DEFAULT_ALL_DAY_REMINDERS_MIN : [...new Set([...DEFAULT_REMINDERS_MIN, ...(row.remind_before_min ? [row.remind_before_min] : [])])];
  setReminders(row.id, row.start_at, row.all_day === 1, offsets);
}

export const agendaRouter = Router();

agendaRouter.get("/", (req, res) => {
  const today = parisNowLocal().slice(0, 10);
  const from = typeof req.query.from === "string" && DATE_RE.test(req.query.from) ? req.query.from : addDays(today, -1);
  const to = typeof req.query.to === "string" && DATE_RE.test(req.query.to) ? req.query.to : addDays(today, 90);
  res.json(listAgenda(from, to));
});

agendaRouter.post("/", (req, res) => {
  try {
    res.status(201).json(addEvent({ ...req.body, source: "user" }).event);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

agendaRouter.put("/:id", (req, res) => {
  try {
    const event = updateEvent(Number(req.params.id), req.body);
    if (!event) return res.status(404).json({ error: "Événement introuvable." });
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

agendaRouter.delete("/:id", (req, res) => {
  deleteEvent(Number(req.params.id));
  res.json({ ok: true });
});
