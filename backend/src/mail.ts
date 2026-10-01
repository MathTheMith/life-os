import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "./db.js";
import { callAiService, parseJsonReply } from "./aiClient.js";
import { getProfileForPrompt } from "./routes/profile.js";
import { addEvent, parisNowLocal, parisToUtc } from "./routes/agenda.js";
import { getState, setState } from "./state.js";
import { sendPush } from "./push.js";

// Read-only mail watch over IMAP (Gmail app passwords, set in .env as
// MAIL_ACCOUNTS=address:apppassword,address2:apppassword2). Every 30 minutes
// new INBOX messages are fetched without marking them read, and the model
// triages them in batches: importance, category, one-line summary, action
// to take, and an agenda event when the mail announces a dated one.
// Senders listed in MAIL_EXCLUDE (comma-separated fragments) are stored but
// never sent to the model.

db.exec(`
  CREATE TABLE IF NOT EXISTS mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    uid INTEGER NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    from_name TEXT,
    from_addr TEXT,
    subject TEXT,
    date TEXT,
    snippet TEXT,
    ai_status TEXT NOT NULL DEFAULT 'pending',
    importance INTEGER,
    category TEXT,
    summary TEXT,
    action TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mail_date ON mail_messages(date);
`);

// user_rating: the user's swipe on a mail, "important" or "not", used as
// examples for the next triages.
if (!(db.prepare("PRAGMA table_info(mail_messages)").all() as { name: string }[]).some((c) => c.name === "user_rating")) {
  db.exec("ALTER TABLE mail_messages ADD COLUMN user_rating TEXT");
}

// notified: an urgent mail already pushed. Mails that existed before this
// column are marked as notified so enabling it doesn't flood the phone.
if (!(db.prepare("PRAGMA table_info(mail_messages)").all() as { name: string }[]).some((c) => c.name === "notified")) {
  db.exec("ALTER TABLE mail_messages ADD COLUMN notified INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE mail_messages SET notified = 1");
}

// direction/to_*: the Sent folder, read the same way as the inbox, so the
// AI knows what Mathéo actually sent (e.g. an application answered straight
// from Gmail on his phone) instead of only relying on him marking a drafted
// action "Envoyé" by hand. Sent mails skip triage entirely — no
// importance/category, nothing to decide, see runMail().
const mailColumns = (db.prepare("PRAGMA table_info(mail_messages)").all() as { name: string }[]).map((c) => c.name);
if (!mailColumns.includes("direction")) {
  db.exec("ALTER TABLE mail_messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'received'");
}
if (!mailColumns.includes("to_name")) db.exec("ALTER TABLE mail_messages ADD COLUMN to_name TEXT");
if (!mailColumns.includes("to_addr")) db.exec("ALTER TABLE mail_messages ADD COLUMN to_addr TEXT");

const FIRST_RUN_DAYS = 7;
// Longer backfill for Sent on its very first run: an application or
// relance sent three weeks ago is still exactly the kind of thing the AI
// should know about, unlike the inbox where 7 days of recent mail is enough.
const SENT_FIRST_RUN_DAYS = 30;
const MAX_PER_RUN = 60;
// Only ever used for the auto-triage prompt until get_mail_text (chatTools.ts)
// started exposing it on request — raised from 1000 so asking the AI to
// actually read a mail doesn't hit the same wall nearly as often. Storage
// cost is negligible at this mailbox's scale.
const SNIPPET_CHARS = 4000;
const BATCH_SIZE = 10;
export const MAIL_CATEGORIES = ["recrutement", "candidature", "administratif", "banque", "perso", "achat", "pub", "autre"] as const;

interface Account {
  user: string;
  pass: string;
}

export function mailAccounts(): Account[] {
  return (process.env.MAIL_ACCOUNTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(":");
      return { user: entry.slice(0, i), pass: entry.slice(i + 1).replace(/\s+/g, "") };
    })
    .filter((a) => a.user && a.pass);
}

function isExcluded(fromAddr: string): boolean {
  const fragments = (process.env.MAIL_EXCLUDE ?? "")
    .split(",")
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
  return fragments.some((f) => fromAddr.toLowerCase().includes(f));
}

// Gmail's Sent folder has a different literal name per account language
// ("[Gmail]/Sent Mail", "[Gmail]/Messages envoyés"...) — IMAP's SPECIAL-USE
// extension (which Gmail supports) is the only locale-proof way to find it.
// Cached per account so a normal run doesn't open a connection just to ask.
async function resolveSentFolder(account: Account): Promise<string | null> {
  const cacheKey = `mail_sent_folder:${account.user}`;
  const cached = getState(cacheKey);
  if (cached) return cached;

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
  await client.connect();
  try {
    const list = await client.list();
    const path = list.find((m) => m.specialUse === "\\Sent")?.path ?? null;
    if (path) setState(cacheKey, path);
    return path;
  } finally {
    await client.logout().catch(() => {});
  }
}

async function fetchNewMessages(account: Account, folder: string, direction: "received" | "sent"): Promise<number> {
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
  await client.connect();
  let saved = 0;
  try {
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const mailbox = client.mailbox;
      const uidValidity = mailbox ? String(mailbox.uidValidity) : "";
      const cursorKey = `mail_cursor:${account.user}:${direction}`;
      const cursor = JSON.parse(getState(cursorKey) ?? "null") as { uidValidity: string; lastUid: number } | null;
      const lastUid = cursor && cursor.uidValidity === uidValidity ? cursor.lastUid : 0;

      const found = await client.search(
        lastUid
          ? { uid: `${lastUid + 1}:*` }
          : { since: new Date(Date.now() - (direction === "sent" ? SENT_FIRST_RUN_DAYS : FIRST_RUN_DAYS) * 24 * 3600 * 1000) },
        { uid: true }
      );
      // "N:*" always matches the newest message even when it's below N.
      const uids = (found || []).filter((uid) => uid > lastUid).sort((a, b) => a - b).slice(-MAX_PER_RUN);

      const insert = db.prepare(
        `INSERT OR IGNORE INTO mail_messages
           (account, uid, message_id, from_name, from_addr, to_name, to_addr, subject, date, snippet, ai_status, direction)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let maxUid = lastUid;
      if (uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, source: { maxLength: 200_000 } }, { uid: true })) {
          maxUid = Math.max(maxUid, msg.uid);
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const text = (parsed.text ?? "").replace(/\s+/g, " ").trim();

          if (direction === "received") {
            const from = parsed.from?.value?.[0];
            const fromAddr = from?.address ?? "";
            const excluded = isExcluded(fromAddr);
            const result = insert.run(
              account.user,
              msg.uid,
              parsed.messageId ?? `${account.user}:${uidValidity}:${msg.uid}`,
              from?.name ?? null,
              fromAddr,
              null,
              null,
              parsed.subject ?? "(sans objet)",
              (parsed.date ?? new Date()).toISOString(),
              excluded ? null : text.slice(0, SNIPPET_CHARS),
              excluded ? "excluded" : "pending",
              "received"
            );
            saved += result.changes;
          } else {
            // Sent mail is never excluded (he chose to send it himself) and
            // skips triage: no importance/category to decide, so ai_status
            // goes straight to "sent" and triagePending() never sees it.
            // mailparser types `to` as possibly an array (several To:
            // addresses can each be their own AddressObject), unlike `from`.
            const toObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
            const to = toObj?.value?.[0];
            const result = insert.run(
              account.user,
              msg.uid,
              parsed.messageId ?? `${account.user}:${uidValidity}:${msg.uid}:sent`,
              null,
              null,
              to?.name ?? null,
              to?.address ?? null,
              parsed.subject ?? "(sans objet)",
              (parsed.date ?? new Date()).toISOString(),
              text.slice(0, SNIPPET_CHARS),
              "sent",
              "sent"
            );
            saved += result.changes;
          }
        }
      }
      setState(cursorKey, JSON.stringify({ uidValidity, lastUid: maxUid }));
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return saved;
}

interface PendingMail {
  id: number;
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
  date: string;
  snippet: string | null;
}

// Mails often mention dates that are already over (confirmations, reminders
// of the day): only future ones belong in the agenda.
function isUpcoming(start: string): boolean {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(start) ? parisToUtc(`${start}T23:59`) : parisToUtc(start);
  return at.getTime() > Date.now();
}

// Grouped by sender instead of one line per rated mail — the same
// newsletter or contact swiped the same way ten times doesn't need ten
// near-identical lines, and the counts make the trend visible (8 jugés
// important sur 9 reads very differently from 1 sur 9) instead of just
// whatever the latest verdict happened to be. 100 raw ratings costs only a
// few hundred tokens once grouped — nowhere near a real budget concern.
function ratingExamples(): string {
  const rows = db
    .prepare(
      "SELECT from_name, from_addr, subject, user_rating FROM mail_messages WHERE user_rating IS NOT NULL ORDER BY date DESC LIMIT 100"
    )
    .all() as { from_name: string | null; from_addr: string | null; subject: string | null; user_rating: string }[];

  const bySender = new Map<string, { label: string; subject: string; important: number; not: number }>();
  for (const r of rows) {
    const key = r.from_addr || r.from_name || "?";
    const entry = bySender.get(key) ?? {
      label: `${r.from_name || ""} <${r.from_addr ?? ""}>`,
      subject: r.subject ?? "",
      important: 0,
      not: 0,
    };
    if (r.user_rating === "important") entry.important += 1;
    else entry.not += 1;
    bySender.set(key, entry);
  }

  const lines = [...bySender.values()]
    .sort((a, b) => b.important + b.not - (a.important + a.not))
    .map((e) => `- ${e.label} (ex : "${e.subject}") : ${e.important} jugé(s) important, ${e.not} jugé(s) sans intérêt`);

  return lines.join("\n") || "(aucun jugement encore)";
}

// The performance log fills itself from the result mails (Park Events and
// the like) so the AI can follow the lap times without any manual entry.
function recordLap(mail: PendingMail, chrono: { lieu?: string; session?: string; position?: number }, lap: number) {
  const event = [chrono.lieu || mail.from_name || "Karting", chrono.session ? `session ${chrono.session}` : ""].filter(Boolean).join(", ");
  const date = mail.date.slice(0, 10);
  if (db.prepare("SELECT 1 FROM race_logs WHERE date = ? AND event = ?").get(date, event)) return;
  db.prepare(
    "INSERT INTO race_logs (date, event, type, course_chrono, position_finale, notes) VALUES (?, ?, 'karting', ?, ?, ?)"
  ).run(date, event, lap, Number.isInteger(Number(chrono.position)) ? Number(chrono.position) : null, "Ajouté automatiquement depuis le mail de résultats.");
}

async function triageBatch(mails: PendingMail[]) {
  const list = mails
    .map(
      (m, i) =>
        `### Mail ${i}\nDe : ${m.from_name ?? ""} <${m.from_addr ?? ""}>\nDate : ${m.date}\nObjet : ${m.subject ?? ""}\n${m.snippet ?? ""}`
    )
    .join("\n\n");

  const prompt =
    `Tu tries les mails reçus par Mathéo. Nous sommes le ${parisNowLocal().replace("T", " ")} (heure de Paris). ` +
    "Réponds uniquement avec un objet JSON :\n" +
    '{"mails": [{"i": 0, "importance": 0-100, "categorie": "' +
    MAIL_CATEGORIES.join('" | "') +
    '", "resume": "une phrase", "action": "ce qu\'il doit faire, ou null", ' +
    '"evenement": {"titre": "...", "debut": "AAAA-MM-JJTHH:MM ou AAAA-MM-JJ", "rappels_min": [1440, 60]} ou null, ' +
    '"chrono": {"lieu": "...", "session": "nom ou numéro de session", "meilleur_tour_s": 48.725, "position": 3 ou null} ou null}]}\n\n' +
    "- chrono : seulement pour un mail qui donne SES propres résultats de karting ou de simracing (meilleur tour en secondes).\n" +
    "- importance : pour LUI, d'après son profil. Réponse d'une entreprise où il a candidaté, entretien, recruteur : 85 à 100. " +
    "Administratif avec échéance, école, argent : 60 à 85. Résultats de ses propres sessions de karting ou de simracing (chronos) : 45 à 55, utiles pour son suivi pilote. " +
    "Perso : selon le contenu. Pub, newsletter, notification automatique : moins de 15.\n" +
    "- categorie : candidature = réponse à une de ses candidatures ; recrutement = autre contact ou offre d'emploi/stage.\n" +
    "- Mails Intra 42 de revue de code (« You will review/evaluate... ») : regarde le délai annoncé AVANT de noter. " +
    "Si c'est imminent (« in 15 minutes », « dans X minutes », maintenant) → 90 à 100, il doit s'y préparer tout de suite. " +
    "Si c'est juste l'annonce d'une revue prévue à une date/heure donnée, sans urgence immédiate (« from <date> <heure> for X minutes ») → moins de 15, pure info à archiver, pas à notifier.\n" +
    "- evenement : seulement si le mail fixe une date précise À VENIR qui le concerne (entretien, rendez-vous, échéance, course, livraison importante). Heure de Paris. " +
    "rappels_min en minutes avant : entretien ou échéance importante [10080, 4320, 1440, 720, 60], rendez-vous [1440, 120].\n" +
    "- resume et action : concrets, en français correct avec les accents, pas de tirets cadratins.\n\n" +
    `## Profil\n${getProfileForPrompt() || "(vide)"}\n\n` +
    `## Ses jugements passés (ajuste l'importance sur ces exemples, même expéditeur ou même type de mail)\n${ratingExamples()}\n\n` +
    `## Mails\n${list}`;

  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonReply(raw);
  const results: any[] = Array.isArray(parsed.mails) ? parsed.mails : [];

  const update = db.prepare(
    "UPDATE mail_messages SET ai_status = 'done', importance = ?, category = ?, summary = ?, action = ? WHERE id = ?"
  );
  for (const r of results) {
    const mail = mails[Number(r.i)];
    if (!mail) continue;
    const category = (MAIL_CATEGORIES as readonly string[]).includes(r.categorie) ? r.categorie : "autre";
    const importance = Math.max(0, Math.min(100, Math.round(Number(r.importance) || 0)));
    update.run(importance, category, r.resume ? String(r.resume) : null, r.action ? String(r.action) : null, mail.id);
    const lap = Number(r.chrono?.meilleur_tour_s);
    if (r.chrono && Number.isFinite(lap) && lap > 0) recordLap(mail, r.chrono, lap);
    if (r.evenement?.titre && r.evenement?.debut && isUpcoming(String(r.evenement.debut))) {
      try {
        addEvent({
          title: String(r.evenement.titre),
          start: String(r.evenement.debut),
          reminders_min: Array.isArray(r.evenement.rappels_min) ? r.evenement.rappels_min : undefined,
          notes: `Depuis le mail « ${mail.subject ?? ""} » de ${mail.from_name || mail.from_addr}`,
          source: "mail",
        });
      } catch (err) {
        console.error("Mail → agenda :", (err as Error).message);
      }
    }
  }
}

async function triagePending() {
  const pending = db
    .prepare("SELECT id, from_name, from_addr, subject, date, snippet FROM mail_messages WHERE ai_status = 'pending' ORDER BY date LIMIT 60")
    .all() as PendingMail[];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    try {
      await triageBatch(batch);
    } catch (err) {
      // Left pending, retried on the next run.
      console.error("Tri des mails :", (err as Error).message);
    }
  }
}

// Pushes right away the mails that can't wait for the morning brief: an
// answer to an application, an interview, a recruiter, or anything the
// triage scored very high. Only recent mails, each at most once.
async function notifyUrgent() {
  const urgent = db
    .prepare(
      `SELECT id, from_name, from_addr, subject, summary, action FROM mail_messages
       WHERE ai_status = 'done' AND notified = 0 AND date >= datetime('now', '-1 day')
       AND (importance >= 90 OR (importance >= 75 AND category IN ('candidature', 'recrutement')))`
    )
    .all() as { id: number; from_name: string | null; from_addr: string | null; subject: string; summary: string | null; action: string | null }[];
  for (const mail of urgent) {
    db.prepare("UPDATE mail_messages SET notified = 1 WHERE id = ?").run(mail.id);
    await sendPush({
      title: `📬 ${mail.from_name || mail.from_addr}`.slice(0, 60),
      body: `${mail.summary ?? mail.subject}${mail.action ? ` 👉 ${mail.action}` : ""}`.slice(0, 200),
      url: "/?view=mails",
      tag: `mail-${mail.id}`,
    });
  }
  // Everything else triaged is considered handled, so a later rescore
  // can't push an old mail.
  db.prepare("UPDATE mail_messages SET notified = 1 WHERE ai_status = 'done' AND notified = 0").run();
}

let running = false;
// A new mail announced while a run is in progress: run again right after.
let rerun = false;

export function isMailRunning() {
  return running;
}

export async function runMail(): Promise<{ fetched: number }> {
  if (running) {
    rerun = true;
    return { fetched: 0 };
  }
  running = true;
  let fetched = 0;
  try {
    for (const account of mailAccounts()) {
      try {
        fetched += await fetchNewMessages(account, "INBOX", "received");
        const sentFolder = await resolveSentFolder(account);
        if (sentFolder) fetched += await fetchNewMessages(account, sentFolder, "sent");
        setState(`mail_error:${account.user}`, "");
      } catch (err) {
        const message = (err as Error).message || "Erreur inconnue";
        console.error(`Mails ${account.user} :`, message);
        setState(`mail_error:${account.user}`, message);
      }
    }
    await triagePending();
    await notifyUrgent();
    setState("mail_last_run", new Date().toISOString());
  } finally {
    running = false;
  }
  if (rerun) {
    rerun = false;
    runMail().catch((err) => console.error("Mails :", err));
  }
  return { fetched };
}

// Keeps an IMAP connection open on the inbox (IDLE): Gmail announces each
// new mail and it's triaged within a minute, so an appointment "in 20 min"
// isn't discovered half an hour late. Reconnects whenever the connection
// drops (Gmail closes idle ones after a while).
async function watchInbox(account: Account) {
  let debounce: NodeJS.Timeout | undefined;
  const onNewMail = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runMail().catch((err) => console.error("Mails :", err)), 5000);
  };
  for (;;) {
    const client = new ImapFlow({
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      auth: { user: account.user, pass: account.pass },
      logger: false,
    });
    try {
      await client.connect();
      await client.mailboxOpen("INBOX", { readOnly: true });
      client.on("exists", onNewMail);
      await new Promise<void>((resolve) => {
        client.on("close", () => resolve());
        client.on("error", () => resolve());
      });
    } catch (err) {
      console.error(`Mails (écoute ${account.user}) :`, (err as Error).message);
    } finally {
      client.removeAllListeners();
      await client.logout().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 30 * 1000));
  }
}

export function startMailScheduler() {
  if (mailAccounts().length === 0) {
    console.log("Mails : aucun compte dans MAIL_ACCOUNTS, lecture désactivée.");
    return;
  }
  const tick = () => runMail().catch((err) => console.error("Mails :", err));
  setTimeout(tick, 30 * 1000);
  // Safety net behind the live watch below.
  setInterval(tick, 30 * 60 * 1000);
  for (const account of mailAccounts()) void watchInbox(account);
}

// direction defaults to "received": the swipe-triage UI and the get_mails
// chat tool are both about deciding what to do with mail that came in, and
// a sent mail has no importance/category to show there anyway.
export function listMails(days: number, minImportance = 0, direction: "received" | "sent" | "all" = "received") {
  const directionClause = direction === "all" ? "" : "AND direction = ?";
  return db
    .prepare(
      `SELECT id, account, from_name, from_addr, to_name, to_addr, subject, date, importance, category, summary, action, ai_status, user_rating, direction
       FROM mail_messages WHERE date >= datetime('now', ?) AND (importance IS NULL OR importance >= ?) ${directionClause}
       ORDER BY date DESC`
    )
    .all(...(direction === "all" ? [`-${days} days`, minImportance] : [`-${days} days`, minImportance, direction]));
}

// The actual text of one mail, by the id get_mails already gave the model —
// listMails() above deliberately leaves this out (it can return many rows,
// and most questions only need the one-line summary), so reading a specific
// mail for real goes through this instead.
export function getMailText(id: number) {
  return db
    .prepare(
      `SELECT id, direction, from_name, from_addr, to_name, to_addr, subject, date, snippet
       FROM mail_messages WHERE id = ?`
    )
    .get(id);
}

// For prompts: important received mails of the last few days.
export function getMailForPrompt(days = 3, minImportance = 60): string {
  return (listMails(days, minImportance, "received") as any[])
    .filter((m) => m.ai_status === "done")
    .map(
      (m) =>
        `- ${m.date.slice(0, 16).replace("T", " ")} [${m.category}, ${m.importance}/100] ${m.from_name || m.from_addr} : ${m.summary}` +
        (m.action ? ` Action : ${m.action}` : "")
    )
    .join("\n");
}

// For prompts: what Mathéo himself actually sent, regardless of whether a
// drafted action was ever marked "Envoyé" — ground truth from his Sent
// folder rather than relying on him remembering to confirm it in the app.
export function getSentMailForPrompt(days = 30): string {
  return (listMails(days, 0, "sent") as any[])
    .map((m) => `- ${m.date.slice(0, 16).replace("T", " ")} à ${m.to_name || m.to_addr} : ${m.subject}`)
    .join("\n");
}
