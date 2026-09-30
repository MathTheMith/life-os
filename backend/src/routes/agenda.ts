import { Router } from "express";
import { db } from "../db.js";

// The user's agenda, kept by the AI: it adds events it spots in mails, in
// the evening chat or when asked in the chat, and the user can edit them.
// Times are Paris wall-clock strings ("2026-10-05T14:00", or "2026-10-05"
// for all-day events); remind_at is the matching UTC instant the reminder
// job (step 5) looks at.

db.exec(`
  CREATE TABLE IF NOT EXISTS agenda_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start_at TEXT NOT NULL,
    end_at TEXT,
    all_day INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    remind_before_min INTEGER,
    remind_at TEXT,
    reminded INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'user',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_agenda_start ON agenda_events(start_at);
`);

export type AgendaSource = "user" | "chat" | "journal" | "mail";

export interface AgendaEvent {
  id: number;
  title: string;
  start_at: string;
  end_at: string | null;
  all_day: number;
  notes: string | null;
  remind_before_min: number | null;
  remind_at: string | null;
  reminded: number;
  source: AgendaSource;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const DEFAULT_REMIND_MIN = 60;
// All-day events are reminded the morning of the day.
const ALL_DAY_REMIND_TIME = "08:30";

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

function computeRemindAt(start: string, allDay: boolean, remindBeforeMin: number | null): string | null {
  if (allDay) return parisToUtc(`${start}T${ALL_DAY_REMIND_TIME}`).toISOString();
  if (remindBeforeMin === null) return null;
  return new Date(parisToUtc(start).getTime() - remindBeforeMin * 60 * 1000).toISOString();
}

export interface EventInput {
  title: string;
  start: string;
  end?: string | null;
  all_day?: boolean;
  notes?: string | null;
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
  const remind =
    input.remind_before_min === null ? null : Number.isFinite(Number(input.remind_before_min)) ? Number(input.remind_before_min) : DEFAULT_REMIND_MIN;
  return { title, startAt, end, allDay, notes: input.notes ? String(input.notes) : null, remind };
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
    .prepare(
      `INSERT INTO agenda_events (title, start_at, end_at, all_day, notes, remind_before_min, remind_at, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(e.title, e.startAt, e.end, e.allDay ? 1 : 0, e.notes, e.remind, computeRemindAt(e.startAt, e.allDay, e.remind), input.source ?? "user");
  return { event: getEvent(Number(result.lastInsertRowid))!, created: true };
}

export function updateEvent(id: number, input: EventInput): AgendaEvent | undefined {
  const e = normalize(input);
  db.prepare(
    `UPDATE agenda_events SET title = ?, start_at = ?, end_at = ?, all_day = ?, notes = ?, remind_before_min = ?,
     remind_at = ?, reminded = 0 WHERE id = ?`
  ).run(e.title, e.startAt, e.end, e.allDay ? 1 : 0, e.notes, e.remind, computeRemindAt(e.startAt, e.allDay, e.remind), id);
  return getEvent(id);
}

export function deleteEvent(id: number) {
  db.prepare("DELETE FROM agenda_events WHERE id = ?").run(id);
}

function getEvent(id: number) {
  return db.prepare("SELECT * FROM agenda_events WHERE id = ?").get(id) as AgendaEvent | undefined;
}

// Events whose start day is between from and to (inclusive, "YYYY-MM-DD").
export function listAgenda(from: string, to: string): AgendaEvent[] {
  return db
    .prepare("SELECT * FROM agenda_events WHERE substr(start_at, 1, 10) BETWEEN ? AND ? ORDER BY start_at")
    .all(from, to) as AgendaEvent[];
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getAgendaForPrompt(days = 21): string {
  const today = parisNowLocal().slice(0, 10);
  return listAgenda(today, addDays(today, days))
    .map((e) => `- [id ${e.id}] ${e.all_day ? e.start_at : e.start_at.replace("T", " ")} : ${e.title}${e.notes ? ` (${e.notes})` : ""}`)
    .join("\n");
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
