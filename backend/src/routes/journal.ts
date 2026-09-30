import { Router } from "express";
import { db } from "../db.js";
import { callAiService } from "../aiClient.js";
import { getProfileForPrompt } from "./profile.js";
import { addEvent } from "./agenda.js";

// Evening journal, fed by the "chat du soir": a daily conversation where the
// AI asks about the day. When the user finishes it, the transcript becomes
// that day's entry, and the model stores a one-line summary, mood/energy
// (1-5), a short feedback and durable facts about the user. Summaries and
// facts are what the chat (and later the morning brief) see.

db.exec(`
  CREATE TABLE IF NOT EXISTS journal_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    content TEXT NOT NULL,
    mood INTEGER,
    energy INTEGER,
    ai_status TEXT NOT NULL DEFAULT 'pending',
    ai_summary TEXT,
    ai_feedback TEXT,
    ai_facts TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_journal_date ON journal_entries(date);
`);

// An evening chat is a normal conversation tagged with kind = 'soir' and
// its date, so the chat route can give it its own instructions.
const conversationColumns = (db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map((c) => c.name);
const journalColumns = (db.prepare("PRAGMA table_info(journal_entries)").all() as { name: string }[]).map((c) => c.name);
if (!journalColumns.includes("ai_questions")) {
  db.exec("ALTER TABLE journal_entries ADD COLUMN ai_questions TEXT");
}

if (!conversationColumns.includes("kind")) {
  db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'");
}
if (!conversationColumns.includes("journal_date")) {
  db.exec("ALTER TABLE conversations ADD COLUMN journal_date TEXT");
}
if (!conversationColumns.includes("journal_entry_id")) {
  db.exec("ALTER TABLE conversations ADD COLUMN journal_entry_id INTEGER");
}

interface JournalRow {
  id: number;
  date: string;
  content: string;
  mood: number | null;
  energy: number | null;
  ai_status: "pending" | "done" | "error";
  ai_summary: string | null;
  ai_feedback: string | null;
  ai_facts: string | null;
  ai_questions: string | null;
  created_at: string;
}

function toApi(row: JournalRow) {
  return {
    ...row,
    ai_facts: row.ai_facts ? (JSON.parse(row.ai_facts) as string[]) : [],
    ai_questions: row.ai_questions ? (JSON.parse(row.ai_questions) as string[]) : [],
  };
}

function scale(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
}

// Local calendar date: an entry written at 23:30 in Lyon belongs to that
// day, not to the next UTC day.
function todayInParis(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
}

export function listJournal(days: number) {
  const rows = db
    .prepare(
      "SELECT * FROM journal_entries WHERE date >= date('now', ?) ORDER BY date DESC, id DESC"
    )
    .all(`-${days} days`) as JournalRow[];
  return rows.map(toApi);
}

// Compact block for system prompts: one line per recent entry, plus facts.
export function getJournalForPrompt(days = 7): string {
  return listJournal(days)
    .map((e) => {
      const scores = [e.mood && `humeur ${e.mood}/5`, e.energy && `énergie ${e.energy}/5`].filter(Boolean).join(", ");
      const summary = e.ai_summary || e.content.slice(0, 200);
      const facts = e.ai_facts.length ? ` Faits : ${e.ai_facts.join(" ; ")}` : "";
      return `- ${e.date}${scores ? ` (${scores})` : ""} : ${summary}${facts}`;
    })
    .join("\n");
}

async function analyzeEntry(id: number): Promise<ReturnType<typeof toApi> | undefined> {
  const entry = db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(id) as JournalRow | undefined;
  if (!entry) return;

  const previous = db
    .prepare("SELECT date, ai_summary FROM journal_entries WHERE id != ? AND ai_summary IS NOT NULL ORDER BY date DESC, id DESC LIMIT 5")
    .all(id) as { date: string; ai_summary: string }[];

  const prompt =
    "Tu lis le chat du soir de Mathéo (sa discussion avec son assistant sur sa journée). Réponds uniquement avec un objet JSON :\n" +
    '{"resume": "une phrase factuelle", "humeur": 1-5 ou null, "energie": 1-5 ou null, "retour": "2 ou 3 phrases pour lui", "faits": ["..."], "questions": ["..."], "evenements": [{"titre": "...", "debut": "AAAA-MM-JJTHH:MM ou AAAA-MM-JJ"}]}\n\n' +
    "- humeur, energie : la note qu'il a donnée, sinon ton estimation d'après ce qu'il dit, null si impossible à dire.\n" +
    "- resume : ce qui s'est passé, en une phrase, à la troisième personne.\n" +
    "- retour : direct, concret, sans flatterie ni morale. Relie la journée à ses rêves et objectifs du profil quand c'est pertinent, " +
    "et propose au plus une action simple pour demain. Tutoie-le. Pas de tirets cadratins.\n" +
    "- faits : 0 à 3 informations durables sur lui qui valent d'être retenues (préférence, changement de situation, " +
    "événement important, date à venir). Pas de répétition de l'humeur du jour. Liste vide si rien de durable.\n" +
    "- questions : 0 à 2 questions que TU aimerais lui poser au prochain chat du soir, pour mieux le connaître ou le suivre : " +
    "un manque dans son profil (lignes « À compléter », sujet absent), une situation restée floue, le suivi d'un événement annoncé. " +
    "Pas de question déjà répondue dans le profil ou le journal.\n" +
    `- evenements : les rendez-vous, courses, échéances ou choses à faire à une date précise qu'il mentionne, à venir (heure de Paris, nous sommes le ${entry.date}). Liste vide sinon.\n\n` +
    `## Profil\n${getProfileForPrompt() || "(vide)"}\n\n` +
    `## Jours précédents\n${previous.map((p) => `- ${p.date} : ${p.ai_summary}`).join("\n") || "(aucun)"}\n\n` +
    `## Entrée du ${entry.date}` +
    (entry.mood ? `, humeur ${entry.mood}/5` : "") +
    (entry.energy ? `, énergie ${entry.energy}/5` : "") +
    `\n${entry.content}`;

  try {
    const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
    const text: string = data.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
    const facts = strings(parsed.faits);
    const questions = strings(parsed.questions).slice(0, 2);
    for (const ev of Array.isArray(parsed.evenements) ? parsed.evenements : []) {
      if (!ev?.titre || !ev?.debut) continue;
      try {
        addEvent({ title: String(ev.titre), start: String(ev.debut), notes: "Depuis ton chat du soir", source: "journal" });
      } catch (err) {
        console.error("Journal → agenda :", (err as Error).message);
      }
    }
    db.prepare(
      `UPDATE journal_entries SET ai_status = 'done', ai_summary = ?, ai_feedback = ?, ai_facts = ?, ai_questions = ?,
       mood = COALESCE(?, mood), energy = COALESCE(?, energy) WHERE id = ?`
    ).run(
      String(parsed.resume ?? ""),
      String(parsed.retour ?? ""),
      JSON.stringify(facts),
      JSON.stringify(questions),
      scale(parsed.humeur),
      scale(parsed.energie),
      id
    );
  } catch (err) {
    console.error("Erreur analyse journal:", err);
    db.prepare("UPDATE journal_entries SET ai_status = 'error' WHERE id = ?").run(id);
  }
  return toApi(db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(id) as JournalRow);
}

const EVENING_OPENING = "Salut Mathéo 🌙 Comment s'est passée ta journée ?";

const DATE_TITLE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });

// Instructions added to the chat system prompt for an evening conversation,
// including the questions the AI noted after the previous evening.
export function getEveningInstructions(): string {
  const last = db
    .prepare("SELECT ai_questions FROM journal_entries WHERE ai_questions IS NOT NULL ORDER BY date DESC, id DESC LIMIT 1")
    .get() as { ai_questions: string } | undefined;
  const pending: string[] = last ? JSON.parse(last.ai_questions) : [];

  return (
    "## Mode : chat du soir\n" +
    "Cette conversation est le chat du soir de Mathéo : tu l'aides à faire le point sur sa journée, comme un journal parlé. " +
    "Pose UNE question à la fois, courte et naturelle. Fais 2 à 5 relances au total, choisies selon ce qu'il raconte et ses objectifs du profil " +
    "(candidatures, pilotage, sport, projets, argent, moral). Demande-lui à un moment son humeur et son énergie sur 5 s'il ne les a pas données. " +
    "Ne fais pas de long conseil ici : écoute, creuse, reformule en une phrase si utile. " +
    "Pas de compliments automatiques (« bien joué », « super analyse ») : reste direct et factuel, comme un bon coach. " +
    (pending.length
      ? `Après avoir parlé de sa journée, pose-lui aussi ces questions que tu avais notées la dernière fois (une à la fois) : ${pending
          .map((q) => `« ${q} »`)
          .join(", ")}. `
      : "") +
    "Si une de ses réponses apporte une information durable absente de son profil, propose-lui de l'ajouter au profil (update_profile_section après son oui). " +
    "Quand vous avez fait le tour, dis-lui qu'il peut toucher « Terminer » pour enregistrer son journal."
  );
}

function transcriptOf(conversationId: number): string {
  const rows = db
    .prepare("SELECT role, content FROM conversation_messages WHERE conversation_id = ? ORDER BY id ASC")
    .all(conversationId) as { role: string; content: string }[];
  return rows.map((r) => `${r.role === "user" ? "Mathéo" : "Assistant"} : ${r.content}`).join("\n");
}

function formatFinishMessage(entry: NonNullable<Awaited<ReturnType<typeof analyzeEntry>>>): string {
  if (entry.ai_status !== "done") {
    return "📓 Journal enregistré, mais l'analyse a échoué. Tu pourras la relancer plus tard.";
  }
  const scores = [entry.mood && `humeur ${entry.mood}/5`, entry.energy && `énergie ${entry.energy}/5`].filter(Boolean).join(", ");
  const facts = entry.ai_facts.length ? `\n\n**Je retiens :**\n${entry.ai_facts.map((f) => `- ${f}`).join("\n")}` : "";
  return `📓 **Journal enregistré**${scores ? ` (${scores})` : ""}\n\n${entry.ai_summary}\n\n**Mon retour :** ${entry.ai_feedback}${facts}`;
}

export const journalRouter = Router();

journalRouter.get("/", (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 60, 1), 3650);
  res.json(listJournal(days));
});

// Opens today's evening chat, creating it (with the AI's opening question)
// the first time. Coming back the same evening continues the same one.
journalRouter.post("/evening", (_req, res) => {
  const date = todayInParis();
  const existing = db
    .prepare("SELECT id, title FROM conversations WHERE kind = 'soir' AND journal_date = ?")
    .get(date) as { id: number; title: string } | undefined;
  if (existing) return res.json(existing);

  const title = `🌙 Soir du ${DATE_TITLE.format(new Date(`${date}T12:00:00Z`))}`;
  const create = db.transaction(() => {
    const id = Number(
      db.prepare("INSERT INTO conversations (title, kind, journal_date) VALUES (?, 'soir', ?)").run(title, date).lastInsertRowid
    );
    db.prepare("INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(
      id,
      EVENING_OPENING
    );
    return id;
  });
  res.json({ id: create(), title });
});

// Turns the evening chat into the day's journal entry (created the first
// time, updated if the chat went on after an earlier "Terminer"), waits for
// the analysis and posts it back into the chat.
journalRouter.post("/evening/:conversationId/finish", async (req, res) => {
  const conversation = db
    .prepare("SELECT id, journal_date, journal_entry_id FROM conversations WHERE id = ? AND kind = 'soir'")
    .get(req.params.conversationId) as { id: number; journal_date: string; journal_entry_id: number | null } | undefined;
  if (!conversation) return res.status(404).json({ error: "Chat du soir introuvable." });

  const content = transcriptOf(conversation.id);
  let entryId = conversation.journal_entry_id;
  if (entryId && db.prepare("SELECT 1 FROM journal_entries WHERE id = ?").get(entryId)) {
    db.prepare("UPDATE journal_entries SET content = ?, ai_status = 'pending', updated_at = datetime('now') WHERE id = ?").run(
      content,
      entryId
    );
  } else {
    entryId = Number(
      db.prepare("INSERT INTO journal_entries (date, content) VALUES (?, ?)").run(conversation.journal_date, content)
        .lastInsertRowid
    );
    db.prepare("UPDATE conversations SET journal_entry_id = ? WHERE id = ?").run(entryId, conversation.id);
  }

  const entry = await analyzeEntry(entryId);
  if (!entry) return res.status(500).json({ error: "Entrée introuvable après enregistrement." });
  const message = formatFinishMessage(entry);
  db.prepare("INSERT INTO conversation_messages (conversation_id, role, content) VALUES (?, 'assistant', ?)").run(
    conversation.id,
    message
  );
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversation.id);
  res.json({ message });
});

journalRouter.post("/:id/retry", (req, res) => {
  const result = db.prepare("UPDATE journal_entries SET ai_status = 'pending' WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Entrée introuvable." });
  void analyzeEntry(Number(req.params.id));
  res.json({ ok: true });
});

journalRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM journal_entries WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
