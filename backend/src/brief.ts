import { Router } from "express";
import { db } from "./db.js";
import { callAiService, parseJsonReply } from "./aiClient.js";
import { getProfileForPrompt } from "./routes/profile.js";
import { getJournalForPrompt } from "./routes/journal.js";
import { listAgenda, parisNowLocal } from "./routes/agenda.js";
import { getWatchForPrompt } from "./watch.js";
import { sendPush } from "./push.js";
import { getState, setState, parisNow } from "./state.js";
import { generateMorningActions, getActionsForPrompt } from "./actions.js";

// The daily rhythm: the morning brief at 9:00, and the evening chat
// reminder at 21:30 when the day's journal isn't written yet. Both are
// checked every 5 minutes against a "done for today" marker, so a restart
// around those times doesn't skip or repeat them.

db.exec(`
  CREATE TABLE IF NOT EXISTS briefs (
    date TEXT PRIMARY KEY,
    notification TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const BRIEF_HOUR = 9;
// A brief missed by more than this (server down all morning) is skipped.
const BRIEF_LAST_HOUR = 12;
const EVENING_TIME = { hour: 21, minute: 30 };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatEvents(from: string, to: string): string {
  return listAgenda(from, to)
    .map((e) => `- ${e.all_day ? `${e.start_at} (journée)` : e.start_at.replace("T", " ")} : ${e.title}${e.notes ? ` (${e.notes})` : ""}`)
    .join("\n");
}

function mailsSinceYesterday(): string {
  const rows = db
    .prepare(
      `SELECT from_name, from_addr, category, importance, summary, action FROM mail_messages
       WHERE ai_status = 'done' AND importance >= 50 AND date >= datetime('now', '-1 day') ORDER BY importance DESC LIMIT 10`
    )
    .all() as { from_name: string | null; from_addr: string | null; category: string; importance: number; summary: string; action: string | null }[];
  return rows
    .map((m) => `- [${m.category}, ${m.importance}/100] ${m.from_name || m.from_addr} : ${m.summary}${m.action ? ` Action : ${m.action}` : ""}`)
    .join("\n");
}

function pendingTodos(): string {
  return (db.prepare("SELECT title FROM todos WHERE done = 0 ORDER BY created_at LIMIT 15").all() as { title: string }[])
    .map((t) => `- ${t.title}`)
    .join("\n");
}

function pendingQuestions(): string {
  const row = db
    .prepare("SELECT ai_questions FROM journal_entries WHERE ai_questions IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1")
    .get() as { ai_questions: string } | undefined;
  return row ? (JSON.parse(row.ai_questions) as string[]).map((q) => `- ${q}`).join("\n") : "";
}

export async function generateBrief(date: string): Promise<{ notification: { title: string; body: string }; content: string }> {
  const section = (title: string, body: string) => `## ${title}\n${body || "(rien)"}`;
  const context = [
    section("Profil", getProfileForPrompt()),
    section("Agenda aujourd'hui", formatEvents(date, date)),
    section("Agenda des 7 jours suivants", formatEvents(addDays(date, 1), addDays(date, 7))),
    section("Mails importants depuis hier", mailsSinceYesterday()),
    section("Veille : trouvailles des dernières 24 h (score sur 100)", getWatchForPrompt(60, 1)),
    section("Todos en cours", pendingTodos()),
    section("Journal des 3 derniers jours", getJournalForPrompt(3)),
    section("Questions que tu voulais lui poser", pendingQuestions()),
    section("Actions que tu lui as préparées (il répond oui/non dans l'app)", getActionsForPrompt()),
  ].join("\n\n");

  const prompt =
    `Tu écris le brief du matin de Mathéo pour aujourd'hui, ${new Intl.DateTimeFormat("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    }).format(new Date(`${date}T12:00:00Z`))}. ` +
    "Réponds uniquement avec un objet JSON :\n" +
    '{"notif_titre": "max 45 caractères", "notif_texte": "max 160 caractères, l\'essentiel de la journée", "brief": "markdown"}\n\n' +
    "Le brief, court et lisible sur téléphone, en français avec accents, tutoiement, pas de tirets cadratins, uniquement les rubriques qui ont du contenu :\n" +
    "- 📅 **Aujourd'hui** : ce qui est prévu, avec les heures, et ce qu'il faut préparer.\n" +
    "- 📬 **Mails** : seulement ce qui demande une action ou compte vraiment.\n" +
    "- 🎯 **Veille** : les nouvelles trouvailles pertinentes, avec pourquoi.\n" +
    "- ✅ **Prêt pour toi** : les actions préparées qui attendent son oui (candidatures, relances, sorties, fiches), en une ligne chacune.\n" +
    "- 🗓️ **Cette semaine** : ce qui arrive et qu'il faut anticiper dès maintenant.\n" +
    "- 💡 **Le conseil du jour** : UNE action concrète qui le rapproche de ses rêves ou objectifs, tirée de son profil et de son journal.\n" +
    "Pas d'introduction ni de conclusion, pas de flatterie. N'invente rien qui ne soit pas dans le contexte.\n\n" +
    context;

  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonReply(raw);
  return {
    notification: {
      title: String(parsed.notif_titre ?? "Ton brief du jour").slice(0, 60),
      body: String(parsed.notif_texte ?? "").slice(0, 200),
    },
    content: String(parsed.brief ?? ""),
  };
}

export async function runBrief(date = parisNow().date, notify = true) {
  const brief = await generateBrief(date);
  db.prepare(
    `INSERT INTO briefs (date, notification, content) VALUES (?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET notification = excluded.notification, content = excluded.content, created_at = datetime('now')`
  ).run(date, JSON.stringify(brief.notification), brief.content);
  if (notify) await sendPush({ ...brief.notification, url: "/?tab=todo", tag: "brief" });
  return brief;
}

function eveningJournalDone(date: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM journal_entries WHERE date = ?").get(date));
}

async function sendEveningReminder(date: string) {
  const today = formatEvents(date, date);
  let body = "Deux minutes pour faire le point sur ta journée ?";
  try {
    const data = await callAiService({
      messages: [
        {
          role: "user",
          content:
            "Écris le texte d'une notification (max 110 caractères) qui invite Mathéo à faire son chat du soir (le point sur sa journée). " +
            "Rends-la personnelle en t'appuyant sur ce qu'il avait de prévu aujourd'hui, sans rien inventer. Tutoiement, pas de tirets cadratins, " +
            `réponds uniquement avec le texte.\n\nPrévu aujourd'hui :\n${today || "(rien de particulier)"}`,
        },
      ],
      reasoning_effort: "low",
    });
    const text = String(data.choices?.[0]?.message?.content ?? "").trim().replace(/^"|"$/g, "");
    if (text) body = text.slice(0, 160);
  } catch (err) {
    console.error("Rappel du soir (texte IA) :", (err as Error).message);
  }
  await sendPush({ title: "🌙 Chat du soir", body, url: "/?tab=chat&evening=1", tag: "evening" });
}

let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = parisNow();
    if (now.hour >= BRIEF_HOUR && now.hour < BRIEF_LAST_HOUR && getState("brief_last_date") !== now.date) {
      setState("brief_last_date", now.date);
      // The day's actions first, so the brief can mention them.
      await generateMorningActions().catch((err) => console.error("Actions :", err));
      await runBrief(now.date).catch((err) => console.error("Brief :", err));
    }
    const minutes = now.hour * 60 + now.minute;
    if (minutes >= EVENING_TIME.hour * 60 + EVENING_TIME.minute && getState("evening_reminder_date") !== now.date) {
      setState("evening_reminder_date", now.date);
      if (!eveningJournalDone(now.date)) await sendEveningReminder(now.date).catch((err) => console.error("Soir :", err));
    }
  } finally {
    busy = false;
  }
}

export function startDailyScheduler() {
  setTimeout(() => tick().catch(() => {}), 90 * 1000);
  setInterval(() => tick().catch((err) => console.error("Planning du jour :", err)), 5 * 60 * 1000);
}

export function getTodayBriefForPrompt(): string {
  const row = db.prepare("SELECT content FROM briefs WHERE date = ?").get(parisNowLocal().slice(0, 10)) as
    | { content: string }
    | undefined;
  return row?.content ?? "";
}

export const briefRouter = Router();

briefRouter.get("/today", (_req, res) => {
  const row = db.prepare("SELECT date, content, created_at FROM briefs WHERE date = ?").get(parisNow().date);
  res.json(row ?? null);
});

// Regenerates today's brief on demand (no notification).
briefRouter.post("/today", async (_req, res) => {
  try {
    const brief = await runBrief(parisNow().date, false);
    res.json({ date: parisNow().date, content: brief.content });
  } catch (err) {
    console.error("Brief :", err);
    res.status(502).json({ error: "Impossible de générer le brief, réessaie." });
  }
});
