import { Router } from "express";
import { db } from "./db.js";

// The coach's mood toward the user, from -5 (very unhappy) to +5 (very
// happy). It moves with what the user actually does: the evening review
// raises it when the day's commitments were kept and lowers it for plain
// lack of will, a skipped evening review lowers it too. Every prompt (chat,
// brief, evening chat, notifications) gets the matching tone, so the whole
// app gets warmer or harsher with it.

db.exec(`
  CREATE TABLE IF NOT EXISTS coach_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    satisfaction INTEGER NOT NULL DEFAULT 0,
    comment TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO coach_state (id, satisfaction) VALUES (1, 0);

  CREATE TABLE IF NOT EXISTS coach_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    delta INTEGER NOT NULL,
    satisfaction INTEGER NOT NULL,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const MIN = -5;
const MAX = 5;

export function getCoach(): { satisfaction: number; comment: string | null; updated_at: string } {
  return db.prepare("SELECT satisfaction, comment, updated_at FROM coach_state WHERE id = 1").get() as {
    satisfaction: number;
    comment: string | null;
    updated_at: string;
  };
}

export function adjustCoach(date: string, delta: number, comment: string | null) {
  const step = Math.max(-3, Math.min(3, Math.round(delta)));
  const next = Math.max(MIN, Math.min(MAX, getCoach().satisfaction + step));
  db.prepare("UPDATE coach_state SET satisfaction = ?, comment = ?, updated_at = datetime('now') WHERE id = 1").run(next, comment);
  db.prepare("INSERT INTO coach_history (date, delta, satisfaction, reason) VALUES (?, ?, ?, ?)").run(date, step, next, comment);
}

export function moodLabel(s: number): { emoji: string; label: string } {
  if (s >= 3) return { emoji: "😄", label: "content" };
  if (s >= 1) return { emoji: "🙂", label: "plutôt content" };
  if (s === 0) return { emoji: "😐", label: "neutre" };
  if (s >= -2) return { emoji: "😒", label: "pas content" };
  return { emoji: "😤", label: "très pas content" };
}

// Tone instructions shared by every prompt that talks to the user.
export function toneInstructions(): string {
  const { satisfaction: s, comment } = getCoach();
  const { label } = moodLabel(s);
  const tone =
    s >= 3
      ? "Tu es content et fier de lui : chaleureux, tu célèbres ce qu'il a tenu, avec des mots précis sur ce qu'il a fait, mais tu gardes la barre haute pour la suite."
      : s >= 1
        ? "Tu es plutôt content : encourageant et direct, tu reconnais ce qui est fait et tu pousses sur la suite."
        : s === 0
          ? "Tu es neutre : factuel, direct, exigeant sans chaleur particulière."
          : s >= -2
            ? "Tu n'es pas content : déçu, plus sec, moins de politesses. Tu poses des questions qui dérangent (« qu'est-ce qui s'est vraiment passé ? », « c'est compatible avec ce que tu dis vouloir ? ») et tu lui rappelles ses rêves."
            : "Tu es très mécontent : cru et sévère. Tu ne laisses passer aucune excuse de flemme, tu le mets face à ses contradictions entre ce qu'il dit vouloir (ses rêves, ses objectifs) et ce qu'il fait, " +
              "tu le remets en question sans détour et tu exiges un engagement précis et daté.";
  return (
    `## Ton humeur envers lui : ${label} (${s} sur une échelle de -5 à +5)${comment ? `. Dernière raison : ${comment}` : ""}\n` +
    `${tone}\n` +
    "Limites absolues : jamais d'insulte, de mépris ni d'humiliation, tu vises ses actes, pas sa personne. " +
    "Distingue la flemme ou le manque d'envie (là, tu peux être dur) d'une vraie raison : maladie, vraie fatigue, imprévu, coup dur (là, aucune sévérité). " +
    "S'il montre des signes de vraie détresse, oublie ton humeur : tu le soutiens avec douceur et tu l'encourages à en parler à un proche ou à un professionnel."
  );
}

// What was planned for the day and what the app saw getting done: the
// evening review checks each point against this.
export function dayEvidence(date: string): string {
  const brief = db.prepare("SELECT commitments FROM briefs WHERE date = ?").get(date) as { commitments: string | null } | undefined;
  const commitments: string[] = brief?.commitments ? JSON.parse(brief.commitments) : [];

  const habits = db
    .prepare(
      `SELECT g.title, EXISTS (SELECT 1 FROM goal_checkins c WHERE c.goal_id = g.id AND c.date = ?) AS done
       FROM goals g WHERE g.kind = 'recurrent'`
    )
    .all(date) as { title: string; done: number }[];
  const doneTodos = db.prepare("SELECT title FROM todos WHERE done = 1 AND date(completed_at) = ?").all(date) as { title: string }[];
  const openTodos = db.prepare("SELECT title FROM todos WHERE done = 0").all() as { title: string }[];
  const actions = db
    .prepare("SELECT kind, title, status FROM actions WHERE due_date = ? OR date(updated_at) = ?")
    .all(date, date) as { kind: string; title: string; status: string }[];
  const events = db
    .prepare("SELECT title, start_at FROM agenda_events WHERE substr(start_at, 1, 10) = ? ORDER BY start_at")
    .all(date) as { title: string; start_at: string }[];

  const statusLabel: Record<string, string> = {
    proposed: "pas encore traitée",
    accepted: "brouillon créé, pas encore envoyée",
    done: "faite",
    dismissed: "refusée",
    scheduled: "programmée",
  };
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "(rien)");
  return [
    `### Engagements fixés ce matin dans le brief\n${list(commitments)}`,
    `### Habitudes\n${list(habits.map((h) => `${h.title} : ${h.done ? "cochée" : "PAS cochée"}`))}`,
    `### Tâches terminées aujourd'hui\n${list(doneTodos.map((t) => t.title))}`,
    `### Tâches encore ouvertes\n${list(openTodos.map((t) => t.title))}`,
    `### Actions préparées par toi\n${list(actions.map((a) => `[${a.kind}] ${a.title} : ${statusLabel[a.status] ?? a.status}`))}`,
    `### Agenda du jour\n${list(events.map((e) => `${e.start_at.length > 10 ? e.start_at.slice(11, 16) : "journée"} ${e.title}`))}`,
  ].join("\n\n");
}

export const coachRouter = Router();

coachRouter.get("/", (_req, res) => {
  const coach = getCoach();
  res.json({ ...coach, ...moodLabel(coach.satisfaction) });
});
