import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { db } from "./db.js";
import { callAiService, parseJsonReply } from "./aiClient.js";
import { getProfileForPrompt } from "./routes/profile.js";
import { getJournalForPrompt } from "./routes/journal.js";
import { addEvent, deleteEvent, listAgenda, parisNowLocal } from "./routes/agenda.js";
import { listEnvelopesWithSummary } from "./routes/envelope.js";
import { pageToText } from "./watch.js";
import { mailAccounts } from "./mail.js";
import { sendPush } from "./push.js";

// Actions the AI prepares on its own but never carries out without a yes:
// applications for the offers the user liked, follow-ups a week after an
// application was sent, outings (karting, a race, sport...) and interview
// prep sheets. "Oui" on a mail action only creates a Gmail draft (to the
// recipient, or to the user himself when the text is for a web form):
// the user sends it himself. "Oui" on an outing adds it to the agenda.

db.exec(`
  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    title TEXT NOT NULL,
    reason TEXT,
    body_md TEXT,
    mail_to TEXT,
    mail_subject TEXT,
    mail_body TEXT,
    agenda_title TEXT,
    agenda_start TEXT,
    watch_item_id INTEGER,
    event_id INTEGER,
    todo_id INTEGER,
    parent_id INTEGER,
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export type ActionKind = "candidature" | "relance" | "sortie" | "preparation";
// scheduled: waiting for due_date (follow-ups). proposed: waiting for a
// yes/no. accepted: draft created, waiting for "sent". done / dismissed.
export type ActionStatus = "scheduled" | "proposed" | "accepted" | "done" | "dismissed";

export interface Action {
  id: number;
  kind: ActionKind;
  status: ActionStatus;
  title: string;
  reason: string | null;
  body_md: string | null;
  mail_to: string | null;
  mail_subject: string | null;
  mail_body: string | null;
  agenda_title: string | null;
  agenda_start: string | null;
  watch_item_id: number | null;
  event_id: number | null;
  todo_id: number | null;
  parent_id: number | null;
  due_date: string | null;
  created_at: string;
}

const FROM_NAME = "Mathéo Vachon";
const FOLLOW_UP_DAYS = 7;
const CANDIDATURES_DIR = process.env.CANDIDATURES_DIR || "/app/candidatures";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function getAction(id: number) {
  return db.prepare("SELECT * FROM actions WHERE id = ?").get(id) as Action | undefined;
}

function today(): string {
  return parisNowLocal().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function aiJson(prompt: string): Promise<any> {
  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  return parseJsonReply(raw);
}

const WRITING_RULES =
  "Style : naturel et précis, pas de tirets cadratins, pas de formules creuses ni de flatterie, " +
  "n'invente aucune expérience ni compétence absente du CV, du profil ou des lettres.";

// ---------- Source material: existing cover letters and the CV ----------

function htmlFileText(file: string): string {
  const html = fs.readFileSync(file, "utf8").replace(/data:[^"')]+/g, "");
  return pageToText(html, "https://localhost/");
}

const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

// The letter already written for this company, if any (files are named
// after the company, e.g. wrt.html, hyundai_motorsport.html).
function letterFor(company: string | null): string {
  if (!company || !fs.existsSync(CANDIDATURES_DIR)) return "";
  const target = normalize(company);
  const file = fs
    .readdirSync(CANDIDATURES_DIR)
    .filter((f) => f.endsWith(".html") && f !== "cv.html" && f !== "index.html")
    .find((f) => {
      const key = normalize(f.replace(/\.html$/, ""));
      return key.length >= 3 && (target.includes(key) || key.includes(target));
    });
  return file ? htmlFileText(path.join(CANDIDATURES_DIR, file)) : "";
}

// Any existing letter, as a style reference when none matches the company.
function sampleLetter(): string {
  const file = path.join(CANDIDATURES_DIR, "ligier.html");
  return fs.existsSync(file) ? htmlFileText(file) : "";
}

let cvCache: string | undefined;
function cvText(): string {
  if (cvCache === undefined) {
    const file = path.join(CANDIDATURES_DIR, "cv.html");
    cvCache = fs.existsSync(file) ? htmlFileText(file) : "";
  }
  return cvCache;
}

async function offerPageText(url: string | null): Promise<string> {
  if (!url) return "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return "";
    return pageToText(await res.text(), res.url).slice(0, 8000);
  } catch {
    return "";
  }
}

// ---------- Gmail drafts ----------

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildMessage(from: string, to: string, subject: string, body: string): string {
  const b64 = Buffer.from(body.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `From: ${encodeHeader(FROM_NAME)} <${from}>`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@life-os>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64,
  ].join("\r\n");
}

// Saves the draft in Gmail's Drafts folder (found by its special-use flag,
// the name depends on the account language). Nothing is sent.
async function createGmailDraft(to: string | null, subject: string, body: string) {
  const account = mailAccounts()[0];
  if (!account) throw new Error("Aucun compte mail configuré (MAIL_ACCOUNTS).");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
  await client.connect();
  try {
    const drafts = (await client.list()).find((m) => m.specialUse === "\\Drafts")?.path ?? "[Gmail]/Drafts";
    await client.append(drafts, buildMessage(account.user, to || account.user, subject, body), ["\\Draft"]);
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------- Preparing each kind of action ----------

interface WatchItemRow {
  id: number;
  category: string;
  title: string;
  company: string | null;
  location: string | null;
  url: string | null;
  reason: string | null;
  status: string;
}

export async function prepareCandidature(itemId: number, urgent: boolean): Promise<Action | undefined> {
  const existing = db
    .prepare("SELECT id FROM actions WHERE watch_item_id = ? AND kind = 'candidature' AND status != 'dismissed'")
    .get(itemId) as { id: number } | undefined;
  if (existing) return getAction(existing.id);

  const item = db.prepare("SELECT * FROM watch_items WHERE id = ?").get(itemId) as WatchItemRow | undefined;
  if (!item) return undefined;

  const letter = letterFor(item.company);
  const offer = await offerPageText(item.url);
  const parsed = await aiJson(
    "Prépare la candidature de Mathéo pour cette offre. Réponds uniquement avec un objet JSON :\n" +
      '{"titre": "Candidature : poste, entreprise", "pourquoi": "2 phrases : pourquoi cette offre vaut le coup pour lui", ' +
      '"destinataire": "adresse mail de candidature trouvée sur la page de l\'offre, sinon null", ' +
      '"objet": "objet du mail", "corps": "le texte complet à envoyer", ' +
      '"conseil": "une chose concrète à apprendre, tester ou préparer pour maximiser ses chances sur CETTE offre (ex : un outil demandé), ou null"}\n\n' +
      "- Langue : celle de l'offre (anglais si l'offre est en anglais).\n" +
      "- S'il n'y a pas d'adresse mail (candidature par formulaire), le corps est le message à coller dans le formulaire.\n" +
      "- Court (moins de 200 mots), ciblé sur les exigences de l'offre, avec ses projets concrets. Signe Mathéo Vachon.\n" +
      `- ${WRITING_RULES}\n\n` +
      `## Offre\n${item.title}${item.company ? ` chez ${item.company}` : ""}${item.location ? ` (${item.location})` : ""}\n` +
      `Lien : ${item.url ?? "aucun"}\nPourquoi la veille l'a retenue : ${item.reason ?? ""}\n\n` +
      `## Texte de la page de l'offre\n${offer || "(page indisponible)"}\n\n` +
      `## Profil\n${getProfileForPrompt()}\n\n## CV\n${cvText() || "(indisponible)"}\n\n` +
      (letter
        ? `## Lettre déjà écrite pour cette entreprise (à adapter à l'offre)\n${letter}`
        : `## Exemple de ses lettres (pour le ton)\n${sampleLetter()}`)
  );

  const to = typeof parsed.destinataire === "string" && EMAIL_RE.test(parsed.destinataire) ? parsed.destinataire : null;
  const bodyMd = [parsed.pourquoi, parsed.conseil ? `**À faire pour mettre toutes les chances de ton côté :** ${parsed.conseil}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const result = db
    .prepare(
      `INSERT INTO actions (kind, title, reason, body_md, mail_to, mail_subject, mail_body, watch_item_id, due_date)
       VALUES ('candidature', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(parsed.titre || `Candidature : ${item.title}`),
      to ? `Mail à envoyer à ${to}` : "Candidature par formulaire : le texte te sera envoyé en brouillon pour le copier",
      bodyMd,
      to,
      String(parsed.objet || item.title),
      String(parsed.corps || ""),
      item.id,
      today()
    );
  const id = Number(result.lastInsertRowid);

  if (urgent) {
    const label = `Postuler : ${item.title}${item.company ? ` (${item.company})` : ""}`;
    const todo = db.prepare("INSERT INTO todos (title) VALUES (?)").run(label);
    // A nudge this afternoon, or in an hour if the afternoon is already over.
    const now = parisNowLocal();
    const hour = Math.max(17, Number(now.slice(11, 13)) + 1);
    const event =
      hour <= 22 ? addEvent({ title: label, start: `${today()}T${String(hour).padStart(2, "0")}:00`, reminders_min: [0], source: "chat" }).event : null;
    db.prepare("UPDATE actions SET todo_id = ?, event_id = ? WHERE id = ?").run(Number(todo.lastInsertRowid), event?.id ?? null, id);
    await sendPush({
      title: "⚡ Candidature prête",
      body: `${item.title}${item.company ? ` chez ${item.company}` : ""} : relis-la et dis oui pour l'avoir en brouillon.`,
      url: "/?tab=today",
      tag: `action-${id}`,
    });
  }
  return getAction(id);
}

async function prepareFollowUp(action: Action) {
  const parent = action.parent_id ? getAction(action.parent_id) : undefined;
  const parsed = await aiJson(
    "Écris la relance de Mathéo pour une candidature restée sans réponse depuis une semaine. Réponds uniquement avec un objet JSON " +
      '{"objet": "...", "corps": "..."}.\n' +
      "Très court (moins de 90 mots), poli, qui rappelle en une phrase ce qu'il apporte et redemande un échange. Même langue que la candidature. " +
      `Signe Mathéo Vachon. ${WRITING_RULES}\n\n` +
      `## Candidature envoyée\n${parent ? `Objet : ${parent.mail_subject}\n\n${parent.mail_body}` : action.title}`
  );
  db.prepare(
    "UPDATE actions SET status = 'proposed', mail_subject = ?, mail_body = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(String(parsed.objet ?? `Relance : ${action.title}`), String(parsed.corps ?? ""), action.id);
}

async function preparePrepSheet(event: { id: number; title: string; start_at: string; notes: string | null }) {
  const applications = (
    db.prepare("SELECT title, mail_body FROM actions WHERE kind = 'candidature' ORDER BY id DESC LIMIT 10").all() as {
      title: string;
      mail_body: string | null;
    }[]
  )
    .map((a) => `### ${a.title}\n${(a.mail_body ?? "").slice(0, 1200)}`)
    .join("\n\n");
  const parsed = await aiJson(
    "Prépare la fiche d'entretien de Mathéo. Réponds uniquement avec un objet JSON " +
      '{"titre": "Préparer : ...", "fiche": "markdown"}.\n' +
      "La fiche, lisible sur téléphone : ce qu'il faut savoir sur l'entreprise et le poste (seulement ce qui est dans le contexte, sinon dis quoi vérifier), " +
      "ses 3 atouts à mettre en avant avec des exemples tirés de ses projets, 6 questions probables avec une piste de réponse, " +
      `3 questions à poser, et la logistique (heure, visio ou lieu, matériel). ${WRITING_RULES}\n\n` +
      `## Entretien\n${event.title}, le ${event.start_at.replace("T", " ")}${event.notes ? `\nNotes : ${event.notes}` : ""}\n\n` +
      `## Ses candidatures récentes\n${applications || "(aucune)"}\n\n## Profil\n${getProfileForPrompt()}\n\n## CV\n${cvText()}`
  );
  db.prepare(
    `INSERT INTO actions (kind, title, reason, body_md, mail_subject, mail_body, event_id, due_date)
     VALUES ('preparation', ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    String(parsed.titre || `Préparer : ${event.title}`),
    "Fiche de préparation, « Oui » te l'envoie aussi dans tes brouillons Gmail",
    String(parsed.fiche ?? ""),
    `📋 Fiche : ${event.title}`,
    String(parsed.fiche ?? ""),
    event.id,
    today()
  );
}

async function suggestOutings() {
  const date = today();
  const agenda = listAgenda(date, addDays(date, 10))
    .map((e) => `- ${e.all_day ? `${e.start_at} (journée)` : e.start_at.replace("T", " ")} : ${e.title}`)
    .join("\n");
  const deals = (
    db
      .prepare(
        `SELECT title, company, location, reason, status FROM watch_items WHERE category IN ('bon_plan', 'evenement')
         AND status != 'dismissed' AND last_seen_at >= datetime('now', '-14 days') ORDER BY score DESC LIMIT 10`
      )
      .all() as { title: string; company: string | null; location: string | null; reason: string | null; status: string }[]
  )
    .map((d) => `- ${d.title}${d.company ? ` (${d.company})` : ""}${d.location ? `, ${d.location}` : ""}${d.status === "interested" || d.status === "urgent" ? " [aimé]" : ""} : ${d.reason ?? ""}`)
    .join("\n");
  const past = (
    db
      .prepare("SELECT title, status FROM actions WHERE kind = 'sortie' AND created_at >= datetime('now', '-21 days') ORDER BY id DESC")
      .all() as { title: string; status: string }[]
  )
    .map((a) => `- ${a.title} : ${a.status === "dismissed" ? "refusé" : a.status === "done" ? "accepté" : "en attente"}`)
    .join("\n");

  const parsed = await aiJson(
    `Nous sommes le ${new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))}. ` +
      "Propose à Mathéo 0 à 2 choses à faire dans les prochains jours qui le rapprochent de ses rêves ou lui font du bien : " +
      "une session de karting (le bon jour et le bon tarif), aller voir une course, du sport, un événement, une rencontre utile pour son réseau... " +
      "Choisis un créneau libre de son agenda, respecte son budget et ses contraintes, ne propose pas ce qui est déjà prévu ni ce qu'il a refusé récemment. " +
      "Liste vide si rien de pertinent : mieux vaut rien qu'une idée creuse.\n" +
      'Réponds uniquement avec un objet JSON {"suggestions": [{"titre": "...", "pourquoi": "1 ou 2 phrases concrètes (prix, lieu, intérêt pour lui)", ' +
      '"agenda": {"titre": "...", "debut": "AAAA-MM-JJTHH:MM"} ou null}]}\n' +
      `${WRITING_RULES}\n\n` +
      `## Profil\n${getProfileForPrompt()}\n\n## Agenda des 10 prochains jours\n${agenda || "(vide)"}\n\n` +
      `## Bons plans et événements repérés par la veille\n${deals || "(aucun)"}\n\n` +
      `## Budget (enveloppes)\n${JSON.stringify(listEnvelopesWithSummary())}\n\n` +
      `## Journal récent\n${getJournalForPrompt(7) || "(vide)"}\n\n## Suggestions récentes et sa réponse\n${past || "(aucune)"}`
  );
  const insert = db.prepare(
    `INSERT INTO actions (kind, title, reason, agenda_title, agenda_start, due_date) VALUES ('sortie', ?, ?, ?, ?, ?)`
  );
  for (const s of Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 2) : []) {
    if (!s?.titre) continue;
    const start = typeof s.agenda?.debut === "string" && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s.agenda.debut) ? s.agenda.debut : null;
    insert.run(String(s.titre), String(s.pourquoi ?? ""), start ? String(s.agenda.titre || s.titre) : null, start, date);
  }
}

// ---------- The morning run ----------

let running = false;

export async function generateMorningActions() {
  if (running) return;
  running = true;
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`Actions (${label}) :`, (err as Error).message);
    }
  };
  try {
    const date = today();
    // Unanswered proposals from earlier days make way for today's.
    db.prepare("UPDATE actions SET status = 'dismissed' WHERE kind = 'sortie' AND status = 'proposed' AND due_date < ?").run(addDays(date, -2));

    for (const a of db.prepare("SELECT * FROM actions WHERE status = 'scheduled' AND due_date <= ?").all(date) as Action[]) {
      await step("relance", () => prepareFollowUp(a));
    }

    const liked = db
      .prepare(
        `SELECT i.id FROM watch_items i WHERE i.status IN ('interested', 'urgent') AND i.category IN ('stage', 'alternance', 'emploi')
         AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.watch_item_id = i.id AND a.kind = 'candidature')
         ORDER BY i.score DESC LIMIT 3`
      )
      .all() as { id: number }[];
    for (const { id } of liked) await step("candidature", () => prepareCandidature(id, false));

    const interviews = listAgenda(date, addDays(date, 3)).filter(
      (e) =>
        /entretien|interview|visio avec/i.test(e.title) &&
        !db.prepare("SELECT 1 FROM actions WHERE kind = 'preparation' AND event_id = ?").get(e.id)
    );
    for (const e of interviews) await step("préparation", () => preparePrepSheet(e));

    await step("sorties", suggestOutings);
  } finally {
    running = false;
  }
}

// ---------- Answers from the app ----------

export async function acceptAction(id: number): Promise<Action | undefined> {
  const action = getAction(id);
  if (!action || action.status !== "proposed") return action;

  if (action.kind === "sortie") {
    if (action.agenda_start) {
      const { event } = addEvent({ title: action.agenda_title || action.title, start: action.agenda_start, notes: action.reason, source: "chat" });
      db.prepare("UPDATE actions SET event_id = ? WHERE id = ?").run(event.id, id);
    }
    db.prepare("UPDATE actions SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(id);
    return getAction(id);
  }

  // Text meant for a web form goes to the user himself, marked as such.
  const toSelf = !action.mail_to;
  const subject = toSelf && action.kind !== "preparation" ? `📋 À copier : ${action.mail_subject ?? action.title}` : action.mail_subject ?? action.title;
  await createGmailDraft(action.mail_to, subject, action.mail_body ?? "");
  db.prepare("UPDATE actions SET status = 'accepted', updated_at = datetime('now') WHERE id = ?").run(id);
  return getAction(id);
}

function clearReminders(action: Action) {
  if (action.todo_id) db.prepare("UPDATE todos SET done = 1, completed_at = datetime('now') WHERE id = ?").run(action.todo_id);
  // The agenda entry of a prep sheet is the interview itself: keep it.
  if (action.event_id && action.kind === "candidature") deleteEvent(action.event_id);
}

// "Envoyé" / "Fait". A sent application schedules its follow-up a week
// later, with a reminder in the agenda.
export function completeAction(id: number) {
  const action = getAction(id);
  if (!action) return undefined;
  db.prepare("UPDATE actions SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(id);
  clearReminders(action);
  if (action.kind === "candidature") {
    const due = addDays(today(), FOLLOW_UP_DAYS);
    const title = `Relance : ${action.title.replace(/^Candidature\s*:\s*/i, "")}`;
    db.prepare(
      `INSERT INTO actions (kind, status, title, reason, mail_to, parent_id, due_date)
       VALUES ('relance', 'scheduled', ?, 'Sans réponse depuis une semaine : la relance est prête', ?, ?, ?)`
    ).run(title, action.mail_to, id, due);
    addEvent({ title: `Relancer : ${action.title.replace(/^Candidature\s*:\s*/i, "")}`, start: `${due}T10:00`, reminders_min: [60], source: "chat" });
  }
  return getAction(id);
}

export function dismissAction(id: number) {
  const action = getAction(id);
  if (!action) return undefined;
  db.prepare("UPDATE actions SET status = 'dismissed', updated_at = datetime('now') WHERE id = ?").run(id);
  clearReminders(action);
  return getAction(id);
}

export function updateActionDraft(id: number, fields: { mail_to?: string | null; mail_subject?: string; mail_body?: string }) {
  const action = getAction(id);
  if (!action) return undefined;
  const to = fields.mail_to === undefined ? action.mail_to : fields.mail_to && EMAIL_RE.test(fields.mail_to) ? fields.mail_to : null;
  db.prepare("UPDATE actions SET mail_to = ?, mail_subject = ?, mail_body = ?, updated_at = datetime('now') WHERE id = ?").run(
    to,
    fields.mail_subject ?? action.mail_subject,
    fields.mail_body ?? action.mail_body,
    id
  );
  return getAction(id);
}

export function listActions() {
  return db
    .prepare(
      `SELECT * FROM actions WHERE status IN ('proposed', 'accepted')
       OR (status IN ('done', 'dismissed') AND updated_at >= datetime('now', '-3 days'))
       ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, id DESC`
    )
    .all() as Action[];
}

export function getActionsForPrompt(): string {
  return (db.prepare("SELECT kind, status, title, reason FROM actions WHERE status IN ('proposed', 'accepted') ORDER BY id DESC").all() as {
    kind: string;
    status: string;
    title: string;
    reason: string | null;
  }[])
    .map((a) => `- [${a.kind}, ${a.status === "proposed" ? "en attente de son oui" : "brouillon créé, pas encore envoyé"}] ${a.title}${a.reason ? ` : ${a.reason}` : ""}`)
    .join("\n");
}
