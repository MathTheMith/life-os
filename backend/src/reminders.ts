import { db } from "./db.js";
import { callAiService, parseJsonReply } from "./aiClient.js";
import { getProfileForPrompt } from "./routes/profile.js";
import { getEvent, listAgenda, parisNowLocal, type AgendaEvent } from "./routes/agenda.js";
import { sendPush } from "./push.js";

// Sends agenda reminders as push notifications. Checked every minute; each
// due reminder gets a short message written by the model for this event and
// this moment (what's left to prepare, when to leave...), with a plain
// fallback when the model is unavailable.

// A reminder more than this late (server down, restart) is dropped rather
// than sent out of context.
const STALE_AFTER_MS = 3 * 3600 * 1000;

function describeDelay(offsetMin: number, event: AgendaEvent): string {
  const time = event.all_day ? "" : ` à ${event.start_at.slice(11, 16).replace(":", "h")}`;
  if (offsetMin === 0) return event.all_day ? "aujourd'hui" : "maintenant";
  if (offsetMin < 60) return `dans ${offsetMin} min`;
  if (offsetMin < 24 * 60) return `dans ${Math.round(offsetMin / 60)} h${time ? ` (${time.trim()})` : ""}`;
  const days = Math.round(offsetMin / 1440);
  if (days === 1) return `demain${time}`;
  if (days % 7 === 0) return `dans ${days / 7} semaine${days > 7 ? "s" : ""}${time ? `, ${event.start_at.slice(0, 10)}${time}` : ""}`;
  return `dans ${days} jours${time}`;
}

export async function writeMessage(event: AgendaEvent, offsetMin: number): Promise<{ title: string; body: string }> {
  const when = describeDelay(offsetMin, event);
  const fallback = { title: event.title, body: `${when.charAt(0).toUpperCase()}${when.slice(1)}${event.notes ? `. ${event.notes}` : ""}` };

  const day = event.start_at.slice(0, 10);
  const sameDay = listAgenda(day, day)
    .filter((e) => e.id !== event.id)
    .map((e) => `- ${e.all_day ? "journée" : e.start_at.slice(11, 16)} ${e.title}`)
    .join("\n");

  const prompt =
    "Écris une notification de rappel pour le téléphone de Mathéo. Réponds uniquement avec un objet JSON " +
    '{"titre": "max 40 caractères", "texte": "max 140 caractères"}.\n' +
    "Le texte doit être utile à CE moment précis : ce qu'il reste à préparer, quand partir, quoi relire, selon le délai restant et l'événement. " +
    "Tutoie-le, reste concret, pas de tirets cadratins, pas de formule creuse. N'invente pas d'informations (adresse, trajet) que tu n'as pas.\n\n" +
    `Maintenant : ${parisNowLocal().replace("T", " ")} (Paris)\n` +
    `Événement : ${event.title}\nQuand : ${event.all_day ? `${day}, journée entière` : event.start_at.replace("T", " ")} (${when})\n` +
    (event.notes ? `Notes : ${event.notes}\n` : "") +
    (sameDay ? `Autres choses ce jour-là :\n${sameDay}\n` : "") +
    `\n## Profil\n${getProfileForPrompt() || "(vide)"}`;

  try {
    const data = await callAiService({ messages: [{ role: "user", content: prompt }], reasoning_effort: "low" });
    const raw: string = data.choices?.[0]?.message?.content ?? "";
    const parsed = parseJsonReply(raw);
    if (typeof parsed.titre === "string" && typeof parsed.texte === "string" && parsed.texte.trim()) {
      return { title: parsed.titre.slice(0, 60), body: parsed.texte.slice(0, 200) };
    }
  } catch (err) {
    console.error("Rappel (texte IA) :", (err as Error).message);
  }
  return fallback;
}

let running = false;

async function sendDueReminders() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const due = db
      .prepare("SELECT id, event_id, offset_min, remind_at FROM agenda_reminders WHERE sent = 0 AND remind_at <= ? ORDER BY remind_at")
      .all(new Date(now).toISOString()) as { id: number; event_id: number; offset_min: number; remind_at: string }[];

    for (const reminder of due) {
      // Marked first: a crash mid-send must not repeat the notification.
      db.prepare("UPDATE agenda_reminders SET sent = 1 WHERE id = ?").run(reminder.id);
      if (now - Date.parse(reminder.remind_at) > STALE_AFTER_MS) continue;
      const event = getEvent(reminder.event_id);
      if (!event) continue;
      const message = await writeMessage(event, reminder.offset_min);
      await sendPush({ ...message, url: "/?tab=todo", tag: `event-${event.id}` });
    }
  } finally {
    running = false;
  }
}

export function startReminderScheduler() {
  setInterval(() => sendDueReminders().catch((err) => console.error("Rappels :", err)), 60 * 1000);
}
