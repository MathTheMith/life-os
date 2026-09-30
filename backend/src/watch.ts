import crypto from "node:crypto";
import { db } from "./db.js";
import { callAiService } from "./aiClient.js";
import { getProfileForPrompt } from "./routes/profile.js";
import { getState, setState, parisNow } from "./state.js";

// Daily web watch. Each source is a page (career page, job board listing,
// circuit or karting site) or a Workday job portal. Once a day the text of
// every source is fetched; when it changed since last time, the model pulls
// out the listings that match the profile's "what to watch" section and
// scores them. The user's ⭐/✕ on past items are fed back as examples.

db.exec(`
  CREATE TABLE IF NOT EXISTS watch_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'page',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_hash TEXT,
    last_checked_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS watch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES watch_sources(id) ON DELETE SET NULL,
    dedupe_key TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    company TEXT,
    location TEXT,
    url TEXT,
    score INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

`);

// Starting list, from the internship prospection work (only pages checked to
// be readable without a browser). Editable from the app afterwards.
const DEFAULT_SOURCES: { name: string; url: string; kind: "page" | "workday" }[] = [
  { name: "MotorsportJobs France", url: "https://www.motorsportjobs.com/fr/jobs/france", kind: "page" },
  { name: "MotorsportJobs Stages", url: "https://www.motorsportjobs.com/fr/jobs/internship", kind: "page" },
  { name: "MotorsportJobs Alternance", url: "https://www.motorsportjobs.com/fr/jobs/apprenticeship", kind: "page" },
  { name: "Alpine Racing", url: "https://alliancewd.wd3.myworkdayjobs.com/fr-FR/alpine-racing-careers", kind: "workday" },
  { name: "Michelin alternance et stages", url: "https://recrutement.michelin.fr/alternance-stage", kind: "page" },
  { name: "Boutsen Racing stages", url: "https://boutsenracing.com/en/internship", kind: "page" },
  { name: "W Racing Team", url: "https://www.w-racingteam.com/racing/careers", kind: "page" },
  { name: "Circuit Paul Ricard", url: "https://www.circuitpaulricard.com/fr/circuit/recrutements", kind: "page" },
  { name: "Hyundai Motorsport", url: "https://motorsporthyundai.career.softgarden.de/", kind: "page" },
  { name: "Oreca", url: "https://oreca.recrutement-talents.fr/", kind: "page" },
  { name: "Circuit du Laquais", url: "https://circuitdulaquais.com/", kind: "page" },
  { name: "Park Events", url: "https://www.parkevents.fr/", kind: "page" },
];

if ((db.prepare("SELECT COUNT(*) AS n FROM watch_sources").get() as { n: number }).n === 0) {
  const insert = db.prepare("INSERT INTO watch_sources (name, url, kind) VALUES (?, ?, ?)");
  for (const s of DEFAULT_SOURCES) insert.run(s.name, s.url, s.kind);
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_TEXT_CHARS = 20000;
const PAUSE_BETWEEN_SOURCES_MS = 4000;
export const CATEGORIES = ["stage", "alternance", "emploi", "bon_plan", "evenement", "actu"] as const;

interface Source {
  id: number;
  name: string;
  url: string;
  kind: "page" | "workday";
  last_hash: string | null;
}

// Visible text of a page, links kept as "text (url)" so the model can hand
// back each listing's own link.
function pageToText(html: string, baseUrl: string): string {
  let s = html.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = inner.replace(/<[^>]+>/g, " ").trim();
    try {
      return text ? ` ${text} (${new URL(href, baseUrl).href}) ` : " ";
    } catch {
      return ` ${text} `;
    }
  });
  s = s.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

// Workday portals render client-side; their public JSON endpoint lists the
// same postings: https://<tenant>.<wdN>.myworkdayjobs.com/<lang>/<site>
async function fetchWorkday(url: string): Promise<string> {
  const u = new URL(url);
  const tenant = u.hostname.split(".")[0];
  const site = u.pathname.split("/").filter(Boolean).pop();
  const res = await fetch(`${u.origin}/wday/cxs/${tenant}/${site}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: "" }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Workday a répondu ${res.status}`);
  const data = (await res.json()) as { jobPostings?: { title: string; locationsText?: string; externalPath: string }[] };
  return (data.jobPostings ?? [])
    .map((j) => `${j.title} | ${j.locationsText ?? ""} | ${u.origin}${u.pathname}${j.externalPath}`)
    .join("\n");
}

async function fetchSourceText(source: Source): Promise<string> {
  if (source.kind === "workday") return fetchWorkday(source.url);
  const res = await fetch(source.url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Le site a répondu ${res.status}`);
  return pageToText(await res.text(), res.url);
}

function feedbackExamples(): string {
  const rows = db
    .prepare(
      "SELECT title, company, status FROM watch_items WHERE status IN ('interested', 'dismissed') ORDER BY last_seen_at DESC LIMIT 30"
    )
    .all() as { title: string; company: string | null; status: string }[];
  const fmt = (status: string) =>
    rows
      .filter((r) => r.status === status)
      .map((r) => `- ${r.title}${r.company ? ` (${r.company})` : ""}`)
      .join("\n") || "(aucun)";
  return `Ce qui l'a intéressé :\n${fmt("interested")}\n\nCe qu'il a écarté :\n${fmt("dismissed")}`;
}

interface ExtractedItem {
  categorie?: string;
  titre?: string;
  entreprise?: string;
  lieu?: string;
  url?: string | null;
  score?: number;
  pourquoi?: string;
}

async function extractItems(source: Source, text: string): Promise<ExtractedItem[]> {
  const prompt =
    "Tu fais la veille internet de Mathéo. Voici le texte d'une page web. Repère UNIQUEMENT les éléments réellement présents sur la page " +
    "qui correspondent à ce qu'il veut surveiller (voir son profil) : offres de stage, d'alternance ou d'emploi, bons plans (tarifs, promos), " +
    "événements (roulages, stages de pilotage, compétitions), actus utiles. Ignore les menus, mentions légales et le reste.\n\n" +
    "Réponds uniquement avec un objet JSON :\n" +
    `{"items": [{"categorie": "${CATEGORIES.join('" | "')}", "titre": "...", "entreprise": "...", "lieu": "...", ` +
    '"url": "lien exact tiré de la page ou null", "score": 0-100, "pourquoi": "une phrase"}]}\n\n' +
    "- score : pertinence pour LUI (profil, objectifs, contraintes, lieux, dates de disponibilité). Un stage ou une alternance IT en motorsport " +
    "en France près de chez lui vaut 80 à 100. Un poste senior, hors de ses compétences ou très loin sans intérêt particulier vaut moins de 30.\n" +
    "- pourquoi : ce qui le rend intéressant ou non pour lui, concrètement. Pas de tirets cadratins.\n" +
    "- N'invente jamais d'offre ni de lien. Liste vide si rien de pertinent.\n\n" +
    `## Profil\n${getProfileForPrompt() || "(vide)"}\n\n` +
    `## Ses réactions passées\n${feedbackExamples()}\n\n` +
    `## Page : ${source.name} (${source.url})\n${text}`;

  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  return Array.isArray(parsed.items) ? parsed.items : [];
}

function saveItems(source: Source, items: ExtractedItem[]): number {
  const findExisting = db.prepare("SELECT id FROM watch_items WHERE dedupe_key = ?");
  const touch = db.prepare("UPDATE watch_items SET last_seen_at = datetime('now') WHERE id = ?");
  const insert = db.prepare(
    `INSERT INTO watch_items (source_id, dedupe_key, category, title, company, location, url, score, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  for (const item of items) {
    const title = String(item.titre ?? "").trim();
    if (!title) continue;
    const category = (CATEGORIES as readonly string[]).includes(String(item.categorie)) ? String(item.categorie) : "actu";
    const url = typeof item.url === "string" && /^https?:\/\//.test(item.url) ? item.url : null;
    const company = item.entreprise ? String(item.entreprise).trim() : null;
    const key = url ?? `${source.id}|${title}|${company ?? ""}`.toLowerCase();
    const existing = findExisting.get(key) as { id: number } | undefined;
    if (existing) {
      touch.run(existing.id);
      continue;
    }
    const score = Math.max(0, Math.min(100, Math.round(Number(item.score) || 0)));
    insert.run(source.id, key, category, title, company, item.lieu ? String(item.lieu) : null, url, score, item.pourquoi ?? null);
    added++;
  }
  return added;
}

async function checkSource(source: Source): Promise<{ added: number; skipped: boolean }> {
  try {
    const text = await fetchSourceText(source);
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (hash === source.last_hash) {
      db.prepare("UPDATE watch_sources SET last_checked_at = datetime('now'), last_error = NULL WHERE id = ?").run(source.id);
      return { added: 0, skipped: true };
    }
    const items = await extractItems(source, text);
    const added = saveItems(source, items);
    // The hash is only stored once extraction succeeded, so a failed run is
    // retried the next day even if the page didn't change.
    db.prepare("UPDATE watch_sources SET last_hash = ?, last_checked_at = datetime('now'), last_error = NULL WHERE id = ?").run(
      hash,
      source.id
    );
    return { added, skipped: false };
  } catch (err) {
    const message = (err as Error).message || "Erreur inconnue";
    console.error(`Veille ${source.name} :`, message);
    db.prepare("UPDATE watch_sources SET last_checked_at = datetime('now'), last_error = ? WHERE id = ?").run(message, source.id);
    return { added: 0, skipped: false };
  }
}

let running = false;

export function isWatchRunning() {
  return running;
}

export async function runWatch(): Promise<{ added: number }> {
  if (running) return { added: 0 };
  running = true;
  let added = 0;
  try {
    const sources = db.prepare("SELECT id, name, url, kind, last_hash FROM watch_sources WHERE enabled = 1").all() as Source[];
    for (const [i, source] of sources.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_SOURCES_MS));
      added += (await checkSource(source)).added;
    }
    setState("watch_last_run", new Date().toISOString());
    setState("watch_last_run_date", parisNow().date);
  } finally {
    running = false;
  }
  return { added };
}

// Once a day from 7:00 (Paris), so fresh results are ready for the 9:00
// brief. Checked every 15 minutes rather than scheduled at an exact time,
// so a restart or a missed tick just runs it on the next check.
const WATCH_HOUR = 7;
export function startWatchScheduler() {
  const tick = () => {
    const now = parisNow();
    if (now.hour >= WATCH_HOUR && getState("watch_last_run_date") !== now.date) {
      runWatch().catch((err) => console.error("Veille :", err));
    }
  };
  setTimeout(tick, 60 * 1000);
  setInterval(tick, 15 * 60 * 1000);
}

// For prompts: what's new and relevant, best first.
export function getWatchForPrompt(minScore = 60, days = 7): string {
  const rows = db
    .prepare(
      `SELECT category, title, company, location, score, reason, status FROM watch_items
       WHERE score >= ? AND status != 'dismissed' AND first_seen_at >= datetime('now', ?)
       ORDER BY score DESC LIMIT 15`
    )
    .all(minScore, `-${days} days`) as {
    category: string;
    title: string;
    company: string | null;
    location: string | null;
    score: number;
    reason: string | null;
    status: string;
  }[];
  return rows
    .map(
      (r) =>
        `- [${r.category}, ${r.score}/100${r.status === "interested" ? ", ⭐" : ""}] ${r.title}` +
        `${r.company ? ` chez ${r.company}` : ""}${r.location ? ` (${r.location})` : ""}${r.reason ? ` : ${r.reason}` : ""}`
    )
    .join("\n");
}
