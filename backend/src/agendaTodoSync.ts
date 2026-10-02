import { db } from "./db.js";
import { parisNow } from "./state.js";

// Keeps the short-term todo list and the agenda in sync automatically, in
// both directions the user asked for:
// - an event reaches its day (or is still ongoing, for a multi-day one) →
//   it gets a todo, so "do it today" doesn't require copying it by hand.
// - an event's day is over → its auto-added todo disappears, done or not,
//   instead of sitting there as a stale leftover.
// Manually-created todos (agenda_event_id NULL) are never touched.

{
  const todoColumns = (db.prepare("PRAGMA table_info(todos)").all() as { name: string }[]).map((c) => c.name);
  // No FK clause: SQLite foreign key enforcement isn't turned on in this
  // app (see db.ts), so ON DELETE CASCADE here would be decorative —
  // syncAgendaTodos() below does the cleanup itself instead.
  if (!todoColumns.includes("agenda_event_id")) {
    db.exec("ALTER TABLE todos ADD COLUMN agenda_event_id INTEGER");
  }
}

const insertTodo = db.prepare("INSERT INTO todos (title, agenda_event_id) VALUES (?, ?)");

export function syncAgendaTodos() {
  const today = parisNow().date;

  const due = db
    .prepare(
      `SELECT id, title, all_day, start_at FROM agenda_events
       WHERE substr(start_at, 1, 10) <= ?
         AND substr(COALESCE(end_at, start_at), 1, 10) >= ?
         AND NOT EXISTS (SELECT 1 FROM todos WHERE agenda_event_id = agenda_events.id)`
    )
    .all(today, today) as { id: number; title: string; all_day: number; start_at: string }[];
  for (const e of due) {
    const time = e.all_day ? "" : ` (${e.start_at.slice(11, 16)})`;
    insertTodo.run(`${e.title}${time}`, e.id);
  }

  db.prepare(
    `DELETE FROM todos WHERE agenda_event_id IN (
       SELECT id FROM agenda_events WHERE substr(COALESCE(end_at, start_at), 1, 10) < ?
     )`
  ).run(today);

  // SQLite's foreign key enforcement isn't turned on in this app (see
  // db.ts), so ON DELETE CASCADE on agenda_event_id is decorative — an
  // event deleted outright (plans changed, not just past) needs its own
  // cleanup here too.
  db.prepare("DELETE FROM todos WHERE agenda_event_id IS NOT NULL AND agenda_event_id NOT IN (SELECT id FROM agenda_events)").run();
}

// Catches the pure date-rollover cases (midnight turning a future event
// into today's, or today's into yesterday's) that no agenda edit triggers.
export function startAgendaTodoSyncScheduler() {
  syncAgendaTodos();
  setInterval(syncAgendaTodos, 15 * 60 * 1000);
}
