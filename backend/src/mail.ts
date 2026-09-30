import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { db } from "./db.js";
import { callAiService } from "./aiClient.js";
import { getProfileForPrompt } from "./routes/profile.js";
import { addEvent, parisNowLocal } from "./routes/agenda.js";
import { getState, setState } from "./state.js";

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

const FIRST_RUN_DAYS = 7;
const MAX_PER_RUN = 60;
const SNIPPET_CHARS = 1000;
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

async function fetchNewMessages(account: Account): Promise<number> {
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
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const mailbox = client.mailbox;
      const uidValidity = mailbox ? String(mailbox.uidValidity) : "";
      const cursorKey = `mail_cursor:${account.user}`;
      const cursor = JSON.parse(getState(cursorKey) ?? "null") as { uidValidity: string; lastUid: number } | null;
      const lastUid = cursor && cursor.uidValidity === uidValidity ? cursor.lastUid : 0;

      const found = await client.search(
        lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - FIRST_RUN_DAYS * 24 * 3600 * 1000) },
        { uid: true }
      );
      // "N:*" always matches the newest message even when it's below N.
      const uids = (found || []).filter((uid) => uid > lastUid).sort((a, b) => a - b).slice(-MAX_PER_RUN);

      const insert = db.prepare(
        `INSERT OR IGNORE INTO mail_messages (account, uid, message_id, from_name, from_addr, subject, date, snippet, ai_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let maxUid = lastUid;
      if (uids.length) {
        for await (const msg of client.fetch(uids, { uid: true, source: { maxLength: 200_000 } }, { uid: true })) {
          maxUid = Math.max(maxUid, msg.uid);
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const from = parsed.from?.value?.[0];
          const fromAddr = from?.address ?? "";
          const excluded = isExcluded(fromAddr);
          const text = (parsed.text ?? "").replace(/\s+/g, " ").trim();
          const result = insert.run(
            account.user,
            msg.uid,
            parsed.messageId ?? `${account.user}:${uidValidity}:${msg.uid}`,
            from?.name ?? null,
            fromAddr,
            parsed.subject ?? "(sans objet)",
            (parsed.date ?? new Date()).toISOString(),
            excluded ? null : text.slice(0, SNIPPET_CHARS),
            excluded ? "excluded" : "pending"
          );
          saved += result.changes;
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
    '"evenement": {"titre": "...", "debut": "AAAA-MM-JJTHH:MM ou AAAA-MM-JJ", "rappels_min": [1440, 60]} ou null}]}\n\n' +
    "- importance : pour LUI, d'après son profil. Réponse d'une entreprise où il a candidaté, entretien, recruteur : 85 à 100. " +
    "Administratif avec échéance, école, argent : 60 à 85. Perso : selon le contenu. Pub, newsletter, notification automatique : moins de 15.\n" +
    "- categorie : candidature = réponse à une de ses candidatures ; recrutement = autre contact ou offre d'emploi/stage.\n" +
    "- evenement : seulement si le mail fixe une date précise qui le concerne (entretien, rendez-vous, échéance, course, livraison importante). Heure de Paris. " +
    "rappels_min en minutes avant : entretien ou échéance importante [10080, 4320, 1440, 720, 60], rendez-vous [1440, 120].\n" +
    "- resume et action : concrets, en français, pas de tirets cadratins.\n\n" +
    `## Profil\n${getProfileForPrompt() || "(vide)"}\n\n## Mails\n${list}`;

  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
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
    if (r.evenement?.titre && r.evenement?.debut) {
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

let running = false;

export function isMailRunning() {
  return running;
}

export async function runMail(): Promise<{ fetched: number }> {
  if (running) return { fetched: 0 };
  running = true;
  let fetched = 0;
  try {
    for (const account of mailAccounts()) {
      try {
        fetched += await fetchNewMessages(account);
        setState(`mail_error:${account.user}`, "");
      } catch (err) {
        const message = (err as Error).message || "Erreur inconnue";
        console.error(`Mails ${account.user} :`, message);
        setState(`mail_error:${account.user}`, message);
      }
    }
    await triagePending();
    setState("mail_last_run", new Date().toISOString());
  } finally {
    running = false;
  }
  return { fetched };
}

export function startMailScheduler() {
  if (mailAccounts().length === 0) {
    console.log("Mails : aucun compte dans MAIL_ACCOUNTS, lecture désactivée.");
    return;
  }
  const tick = () => runMail().catch((err) => console.error("Mails :", err));
  setTimeout(tick, 30 * 1000);
  setInterval(tick, 30 * 60 * 1000);
}

export function listMails(days: number, minImportance = 0) {
  return db
    .prepare(
      `SELECT id, account, from_name, from_addr, subject, date, importance, category, summary, action, ai_status
       FROM mail_messages WHERE date >= datetime('now', ?) AND (importance IS NULL OR importance >= ?)
       ORDER BY date DESC`
    )
    .all(`-${days} days`, minImportance);
}

// For prompts: important mails of the last few days.
export function getMailForPrompt(days = 3, minImportance = 60): string {
  return (listMails(days, minImportance) as any[])
    .filter((m) => m.ai_status === "done")
    .map(
      (m) =>
        `- ${m.date.slice(0, 16).replace("T", " ")} [${m.category}, ${m.importance}/100] ${m.from_name || m.from_addr} : ${m.summary}` +
        (m.action ? ` Action : ${m.action}` : "")
    )
    .join("\n");
}
