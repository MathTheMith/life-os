import crypto from "node:crypto";
import { db } from "./db.js";
import { callAiService, parseJsonReply } from "./aiClient.js";
import { getProfileForPrompt } from "./routes/profile.js";
import { getState, setState, parisNow } from "./state.js";
import { searchWeb, fetchPageText, type WebSearchResult } from "./web.js";

// Web watch, twice a day. Each source is a page (career page, job board listing,
// circuit or karting site) or a Workday job portal. Once a day the text of
// every source is fetched; when it changed since last time, the model pulls
// out the listings that match the profile's "what to watch" section and
// scores them. The user's ⭐/✕ on past items are fed back as examples.
//
// On top of that fixed list, each run also fires a batch of broad web
// searches (watch_queries) to find things no curated source would ever
// list — a new team, a one-off posting, a company not on anyone's radar
// yet. Deliberately cast wide (quantity over precision): the same scoring
// pass that ranks sourced listings ranks these too, so a lot of mediocre
// hits sorted down costs nothing but a bit of quota — same budget of
// quality control as everything else here, nothing new to maintain.

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

  CREATE TABLE IF NOT EXISTS watch_queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// last_verified_at: the freshness check (see checkQuery) only ever covers
// brand new discoveries — an item saved weeks ago never gets rechecked, so
// a posting that's since closed just sits there looking as valid as the
// day it was found. reverifyOldItems() below uses this to work through the
// backlog a few at a time.
if (!(db.prepare("PRAGMA table_info(watch_items)").all() as { name: string }[]).some((c) => c.name === "last_verified_at")) {
  db.exec("ALTER TABLE watch_items ADD COLUMN last_verified_at TEXT");
}

// Structured fields for the card UI, split out of what used to be one long
// "reason" paragraph — company_desc/duration/stack/mission render as their
// own labeled bits, reason stays just the personal fit judgment.
{
  const watchItemColumns = (db.prepare("PRAGMA table_info(watch_items)").all() as { name: string }[]).map((c) => c.name);
  for (const col of ["company_desc", "duration", "stack", "mission"]) {
    if (!watchItemColumns.includes(col)) db.exec(`ALTER TABLE watch_items ADD COLUMN ${col} TEXT`);
  }
}

if ((db.prepare("SELECT COUNT(*) AS n FROM watch_sources").get() as { n: number }).n === 0) {
  const insert = db.prepare("INSERT INTO watch_sources (name, url, kind) VALUES (?, ?, ?)");
  for (const s of DEFAULT_SOURCES) insert.run(s.name, s.url, s.kind);
}

// Broad on purpose, French and English, several angles on the same goal —
// quantity over precision, see the module comment above. Editable via
// /api/watch/queries afterwards, same as the sources list.
const DEFAULT_QUERIES = [
  "stage ingénieur data motorsport France",
  "alternance motorsport ingénieur France",
  "recrutement écurie course automobile stagiaire",
  "karting recrutement stage alternance France",
  "motorsport internship data engineer Europe",
  "race team internship IT France",
  "stage performance engineer motorsport",
  "simracing esport motorsport recrutement stage",
  "offre emploi motorsport informatique France",
  "WEC F1 Formula E recrutement stage France",
];

if ((db.prepare("SELECT COUNT(*) AS n FROM watch_queries").get() as { n: number }).n === 0) {
  const insert = db.prepare("INSERT INTO watch_queries (query) VALUES (?)");
  for (const q of DEFAULT_QUERIES) insert.run(q);
}

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const MAX_TEXT_CHARS = 20000;
const PAUSE_BETWEEN_SOURCES_MS = 4000;
export const CATEGORIES = ["stage", "alternance", "emploi", "bon_plan", "evenement", "actu"] as const;

// Split into labeled fields instead of one long paragraph, so the card UI
// can render each as its own bit (company blurb, duration, tech stack,
// mission) rather than a wall of text. null is a real, expected value for
// duree/stack when the page just doesn't say — never invent one.
const REASON_INSTRUCTION =
  "- entreprise_desc : 1 à 2 phrases, qui est l'entreprise/la marque et ce qu'elle fait concrètement, même brièvement si la page n'en dit pas plus.\n" +
  "- duree : durée du poste et/ou dates si connues (ex : \"6 mois, à partir de mars 2026\"), null si la page ne le dit pas.\n" +
  "- stack : langages, outils ou compétences techniques demandés (ex : \"Python, C++, ROS\"), null si non précisé ou non pertinent pour cette catégorie.\n" +
  "- mission : 2 à 4 phrases, ce qu'on demande concrètement de faire dans ce poste — pas juste redire le titre.\n" +
  "- pourquoi : 1 à 2 phrases, en quoi ça le concerne lui précisément (son profil, ses objectifs, ce qui colle ou pas).\n" +
  "- Pas de tirets cadratins dans aucun champ texte.\n";

interface Source {
  id: number;
  name: string;
  url: string;
  kind: "page" | "workday";
  last_hash: string | null;
}

// Visible text of a page, links kept as "text (url)" so the model can hand
// back each listing's own link.
export function pageToText(html: string, baseUrl: string): string {
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
      "SELECT title, company, status FROM watch_items WHERE status IN ('interested', 'urgent', 'dismissed') ORDER BY last_seen_at DESC LIMIT 30"
    )
    .all() as { title: string; company: string | null; status: string }[];
  const fmt = (status: string) =>
    rows
      .filter((r) => (status === "interested" ? r.status === "interested" || r.status === "urgent" : r.status === status))
      .map((r) => `- ${r.title}${r.company ? ` (${r.company})` : ""}`)
      .join("\n") || "(aucun)";
  return `Ce qui l'a intéressé :\n${fmt("interested")}\n\nCe qu'il a écarté :\n${fmt("dismissed")}`;
}

interface ExtractedItem {
  categorie?: string;
  titre?: string;
  entreprise?: string;
  entreprise_desc?: string | null;
  lieu?: string;
  duree?: string | null;
  stack?: string | null;
  mission?: string | null;
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
    `{"items": [{"categorie": "${CATEGORIES.join('" | "')}", "titre": "...", "entreprise": "...", "entreprise_desc": "...", "lieu": "...", ` +
    '"duree": "... ou null", "stack": "... ou null", "mission": "...", ' +
    '"url": "lien exact tiré de la page ou null", "score": 0-100, "pourquoi": "..."}]}\n\n' +
    "- score : pertinence pour LUI (profil, objectifs, contraintes, lieux, dates de disponibilité). Un stage ou une alternance IT en motorsport " +
    "en France près de chez lui vaut 80 à 100. Un poste senior, hors de ses compétences ou très loin sans intérêt particulier vaut moins de 30.\n" +
    REASON_INSTRUCTION +
    "- N'invente jamais d'offre ni de lien. Liste vide si rien de pertinent.\n" +
    "- N'inclus une offre QUE si cette page dit, là, maintenant, qu'elle est ouverte. Si le texte indique poste pourvu/clos/expiré, ou s'il s'agit " +
    "d'une actu passée (un événement déjà eu lieu, une annonce datée qui semble ancienne), exclus-la plutôt que de la lister par précaution.\n\n" +
    `## Profil\n${getProfileForPrompt() || "(vide)"}\n\n` +
    `## Ses réactions passées\n${feedbackExamples()}\n\n` +
    `## Page : ${source.name} (${source.url})\n${text}`;

  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonReply(raw);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

const normalizeCompany = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

// A broad search can turn up the same employer under a different URL or
// job title than one he already triaged (liked, marked urgent, or passed
// on) — e.g. a second "General Internship" posting at a company whose
// "Software Developer Intern" role he already swiped on. That shouldn't
// come back as a fresh "new" item demanding another look: it inherits
// whatever he already decided for that company, in the same category.
function inheritedStatus(company: string | null, category: string): string | null {
  if (!company || !["stage", "alternance", "emploi"].includes(category)) return null;
  const target = normalizeCompany(company);
  if (!target) return null;
  const rows = db
    .prepare("SELECT company, status FROM watch_items WHERE category = ? AND status IN ('interested', 'urgent', 'dismissed')")
    .all(category) as { company: string | null; status: string }[];
  return rows.find((r) => r.company && normalizeCompany(r.company) === target)?.status ?? null;
}

// sourceId is null for a search-discovered item (watch_queries has no FK
// of its own — these aren't tied to one page the way a source is, dedup
// below falls back to the label + title + company instead).
function saveItems(sourceId: number | null, sourceLabel: string, items: ExtractedItem[]): number {
  const findExisting = db.prepare("SELECT id FROM watch_items WHERE dedupe_key = ?");
  // A rediscovery refreshes score/reason too, not just last_seen_at — the
  // prompt that produces them keeps improving (e.g. the longer, more
  // detailed "pourquoi" added later), and freezing it forever at whatever
  // it was on first discovery defeats the point of improving it at all.
  // status (the swipe) is the only thing never touched here.
  const update = db.prepare(
    `UPDATE watch_items SET category = ?, title = ?, company = ?, location = ?, score = ?, reason = ?,
       company_desc = ?, duration = ?, stack = ?, mission = ?, last_seen_at = datetime('now')
     WHERE id = ?`
  );
  const insert = db.prepare(
    `INSERT INTO watch_items (source_id, dedupe_key, category, title, company, location, url, score, reason, status, company_desc, duration, stack, mission)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  for (const item of items) {
    const title = String(item.titre ?? "").trim();
    if (!title) continue;
    const category = (CATEGORIES as readonly string[]).includes(String(item.categorie)) ? String(item.categorie) : "actu";
    const url = typeof item.url === "string" && /^https?:\/\//.test(item.url) ? item.url : null;
    const company = item.entreprise ? String(item.entreprise).trim() : null;
    const location = item.lieu ? String(item.lieu) : null;
    const score = Math.max(0, Math.min(100, Math.round(Number(item.score) || 0)));
    const reason = item.pourquoi ?? null;
    const companyDesc = item.entreprise_desc ?? null;
    const duration = item.duree ?? null;
    const stack = item.stack ?? null;
    const mission = item.mission ?? null;
    const key = url ?? `${sourceLabel}|${title}|${company ?? ""}`.toLowerCase();
    const existing = findExisting.get(key) as { id: number } | undefined;
    if (existing) {
      update.run(category, title, company, location, score, reason, companyDesc, duration, stack, mission, existing.id);
      continue;
    }
    insert.run(
      sourceId,
      key,
      category,
      title,
      company,
      location,
      url,
      score,
      reason,
      inheritedStatus(company, category) ?? "new",
      companyDesc,
      duration,
      stack,
      mission
    );
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
    const added = saveItems(source.id, source.name, items);
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

interface Query {
  id: number;
  query: string;
}

async function extractFromSearchResults(query: string, results: WebSearchResult[]): Promise<ExtractedItem[]> {
  if (results.length === 0) return [];
  const list = results.map((r, i) => `### Résultat ${i}\nTitre : ${r.title}\nURL : ${r.url}\n${r.snippet}`).join("\n\n");
  const prompt =
    `Tu fais la veille internet de Mathéo. Voici des résultats d'une recherche web (requête : "${query}"), avec pour chacun le texte ` +
    "de la page LUE À L'INSTANT (pas un extrait de moteur de recherche qui peut dater). " +
    "Repère UNIQUEMENT les éléments qui correspondent à ce qu'il veut surveiller (voir son profil) : offres de stage, d'alternance ou d'emploi, " +
    "bons plans, événements, actus utiles. Ignore ce qui est hors sujet, une page de liste générique sans poste précis, ou un résultat trop vague pour en tirer un titre.\n\n" +
    "Réponds uniquement avec un objet JSON :\n" +
    `{"items": [{"categorie": "${CATEGORIES.join('" | "')}", "titre": "...", "entreprise": "...", "entreprise_desc": "...", "lieu": "...", ` +
    '"duree": "... ou null", "stack": "... ou null", "mission": "...", ' +
    '"url": "url exacte du résultat", "score": 0-100, "pourquoi": "..."}]}\n\n' +
    "- score : pertinence pour LUI (profil, objectifs, contraintes, lieux, dates de disponibilité). Un stage ou une alternance IT en motorsport " +
    "en France près de chez lui vaut 80 à 100. Un poste senior, hors de ses compétences ou très loin sans intérêt particulier vaut moins de 30.\n" +
    REASON_INSTRUCTION +
    "- N'invente jamais d'offre ni d'url : reprends exactement celle du résultat correspondant. Liste vide si rien de pertinent.\n" +
    "- IMPORTANT, un résultat de recherche peut dater : exclus un résultat si la page lue à l'instant dit que le poste est pourvu/clos/expiré, " +
    "si elle est vide, a changé de sujet, ou ne parle plus de cette offre — ne te fie JAMAIS au seul titre du résultat de recherche " +
    "pour décider que l'offre est encore valable, vérifie toujours contre le texte de la page elle-même. " +
    "Si la vérification en direct était impossible (indiqué dans le texte), ce n'est PAS une preuve que l'offre a disparu — juge alors sur " +
    "l'extrait de recherche fourni, avec un score un peu plus prudent plutôt qu'une exclusion automatique.\n\n" +
    `## Profil\n${getProfileForPrompt() || "(vide)"}\n\n` +
    `## Ses réactions passées\n${feedbackExamples()}\n\n` +
    `## Résultats\n${list}`;

  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const raw: string = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonReply(raw);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

// Tavily's snippet comes from its own index, which isn't necessarily
// re-crawled recently — a result can look like an open posting while the
// real page has long since taken it down. Each result's page is re-fetched
// live right before scoring, and the live text replaces the snippet.
// A fetch failure is NOT treated as proof the posting is gone — a 403 is
// often just a site blocking automated requests (motorsportjobs.com does
// this on some pages while its listing page itself is fetchable fine), not
// evidence of anything about the offer. On failure the original snippet is
// kept, with a note flagging that live verification wasn't possible, so
// the model judges with appropriately lower confidence instead of either
// trusting a stale snippet blindly or discarding a possibly-real listing.
async function freshenResults(results: WebSearchResult[]): Promise<WebSearchResult[]> {
  const fresh: WebSearchResult[] = [];
  for (const [i, r] of results.entries()) {
    if (i > 0) await new Promise((res) => setTimeout(res, 1000));
    try {
      const page = await fetchPageText(r.url);
      fresh.push({ ...r, snippet: page.text || r.snippet });
    } catch (err) {
      fresh.push({
        ...r,
        snippet:
          `[Vérification en direct impossible (${(err as Error).message}) — peut être un simple blocage anti-robot du site, ` +
          `pas forcément un signe que l'offre a disparu. Extrait du moteur de recherche (peut dater) :]\n${r.snippet}`,
      });
    }
  }
  return fresh;
}

async function checkQuery(q: Query): Promise<{ added: number }> {
  try {
    const results = await searchWeb(q.query);
    const fresh = await freshenResults(results);
    const items = await extractFromSearchResults(q.query, fresh);
    const added = saveItems(null, `recherche:${q.query}`, items);
    db.prepare("UPDATE watch_queries SET last_run_at = datetime('now'), last_error = NULL WHERE id = ?").run(q.id);
    return { added };
  } catch (err) {
    const message = (err as Error).message || "Erreur inconnue";
    console.error(`Veille (recherche) "${q.query}" :`, message);
    db.prepare("UPDATE watch_queries SET last_run_at = datetime('now'), last_error = ? WHERE id = ?").run(message, q.id);
    return { added: 0 };
  }
}

// Oldest/never-verified first, a handful per run — bounded so this never
// dominates a run's cost, worked through gradually over many runs instead.
const REVERIFY_PER_RUN = 8;

async function isStillOpenLive(url: string): Promise<boolean | null> {
  let page: { text: string };
  try {
    page = await fetchPageText(url);
  } catch {
    // Same ambiguity as a fresh search result (anti-bot block vs. actually
    // gone) — null means "couldn't tell", not "it's closed".
    return null;
  }
  try {
    const data = await callAiService({
      messages: [
        {
          role: "user",
          content:
            "Cette page de poste à pourvoir dit-elle explicitement que le poste est clos, pourvu, expiré, ou la page est-elle " +
            "vide/hors sujet (plus aucun rapport avec une offre) ? Réponds uniquement par OUI ou NON, rien d'autre. " +
            "NON par défaut si tu n'es pas sûr — ne réponds OUI que si c'est écrit ou évident.\n\n" +
            page.text.slice(0, 3000),
        },
      ],
      reasoning_effort: "low",
      max_completion_tokens: 10,
    });
    const answer = (data.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
    return answer.startsWith("OUI");
  } catch {
    return null;
  }
}

// Closes the other half of the freshness fix: checkQuery only ever
// verifies brand new finds, so an item saved weeks ago would otherwise sit
// there looking exactly as valid as the day it was found, forever. Score
// is zeroed (not deleted) when found closed, keeping the original reason
// for context — it just naturally sorts to the bottom from then on.
async function reverifyOldItems(): Promise<number> {
  const candidates = db
    .prepare(
      `SELECT id, url, reason FROM watch_items
       WHERE url IS NOT NULL AND status IN ('new', 'seen', 'interested') AND score >= 40
       ORDER BY (last_verified_at IS NULL) DESC, last_verified_at ASC
       LIMIT ?`
    )
    .all(REVERIFY_PER_RUN) as { id: number; url: string; reason: string | null }[];

  let closed = 0;
  for (const [i, item] of candidates.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    const stillOpenResult = await isStillOpenLive(item.url);
    if (stillOpenResult === true) {
      closed += 1;
      db.prepare("UPDATE watch_items SET score = 0, reason = ?, last_verified_at = datetime('now') WHERE id = ?").run(
        `[Offre probablement retirée, vérifié le ${parisNow().date}] ${item.reason ?? ""}`.trim(),
        item.id
      );
    } else {
      // null (couldn't verify) and false (still looks open) both just
      // push the timestamp forward — only a confirmed "closed" downgrades.
      db.prepare("UPDATE watch_items SET last_verified_at = datetime('now') WHERE id = ?").run(item.id);
    }
  }
  return closed;
}

// Per-item fields (company_desc/duration/stack/mission) added after some
// items were already saved — checkSource skips a page whose hash hasn't
// changed, and checkQuery only ever touches whatever a search happens to
// resurface, so neither naturally goes back and fills in what an older row
// is missing. This does, a few at a time: re-reads the item's own page
// (falling back to a fresh search if the link is dead) and fills in just
// the new fields, in place — status, score history and dedupe_key untouched.
const BACKFILL_PER_RUN = 6;

async function backfillItemDetails(item: { id: number; category: string; title: string; company: string | null; url: string }) {
  let context: string | null = null;
  try {
    context = (await fetchPageText(item.url)).text;
  } catch {
    try {
      const results = await searchWeb(`${item.title} ${item.company ?? ""}`.trim());
      context = results.slice(0, 3).map((r) => `${r.title}\n${r.snippet}`).join("\n\n") || null;
    } catch {
      context = null;
    }
  }
  if (!context) return false;

  const prompt =
    "Tu complètes une fiche déjà présente dans la veille de Mathéo avec des champs qui n'existaient pas encore quand elle a été enregistrée. " +
    "Voici le texte de la page (ou, si le lien ne répond plus, des extraits de recherche à son sujet).\n\n" +
    "Réponds uniquement avec un objet JSON :\n" +
    '{"entreprise_desc": "...", "duree": "... ou null", "stack": "... ou null", "mission": "...", "pourquoi": "..."}\n\n' +
    REASON_INSTRUCTION +
    "- Si le texte ne parle plus clairement de cette offre précise (lien mort retombé sur autre chose), réponds avec tous les champs à null.\n\n" +
    `## Fiche déjà enregistrée\n${item.title}${item.company ? ` chez ${item.company}` : ""} (catégorie : ${item.category})\n\n` +
    `## Profil\n${getProfileForPrompt() || "(vide)"}\n\n` +
    `## Texte\n${context}`;

  const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
  const parsed = parseJsonReply(data.choices?.[0]?.message?.content ?? "");
  if (!parsed.entreprise_desc && !parsed.mission) return false;

  db.prepare(
    `UPDATE watch_items SET company_desc = ?, duration = ?, stack = ?, mission = ?, reason = COALESCE(?, reason) WHERE id = ?`
  ).run(parsed.entreprise_desc ?? null, parsed.duree ?? null, parsed.stack ?? null, parsed.mission ?? null, parsed.pourquoi ?? null, item.id);
  return true;
}

export async function backfillMissingDetails(): Promise<number> {
  const candidates = db
    .prepare(
      `SELECT id, category, title, company, url FROM watch_items
       WHERE url IS NOT NULL AND company_desc IS NULL AND mission IS NULL AND status != 'dismissed'
       ORDER BY score DESC
       LIMIT ?`
    )
    .all(BACKFILL_PER_RUN) as { id: number; category: string; title: string; company: string | null; url: string }[];

  let filled = 0;
  for (const [i, item] of candidates.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      if (await backfillItemDetails(item)) filled += 1;
    } catch (err) {
      console.error(`Veille (complément fiche #${item.id}) :`, (err as Error).message);
    }
  }
  return filled;
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

    const queries = db.prepare("SELECT id, query FROM watch_queries WHERE enabled = 1").all() as Query[];
    for (const [i, q] of queries.entries()) {
      if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_BETWEEN_SOURCES_MS));
      added += (await checkQuery(q)).added;
    }

    const closed = await reverifyOldItems();
    if (closed > 0) console.log(`Veille : ${closed} offre(s) déjà vues marquée(s) comme probablement retirée(s).`);
    const filled = await backfillMissingDetails();
    if (filled > 0) console.log(`Veille : ${filled} fiche(s) complétée(s) avec les nouveaux champs.`);
    setState("watch_last_run", new Date().toISOString());
  } finally {
    running = false;
  }
  return { added };
}

// Morning (ready for the 9:00 brief) and early evening (the day's new
// offers). Checked every 15 minutes rather than scheduled at an exact
// time, so a restart or a missed tick just runs it on the next check.
const WATCH_HOURS = [7, 18];
export function startWatchScheduler() {
  const tick = () => {
    const now = parisNow();
    const slot = [...WATCH_HOURS].reverse().find((h) => now.hour >= h);
    if (slot === undefined) return;
    const key = `${now.date}@${slot}`;
    if (getState("watch_last_slot") !== key) {
      setState("watch_last_slot", key);
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
      `SELECT category, title, company, location, score, reason, status,
         (SELECT a.status FROM actions a WHERE a.watch_item_id = watch_items.id AND a.kind = 'candidature' ORDER BY a.id DESC LIMIT 1) AS application
       FROM watch_items
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
    application: string | null;
  }[];
  const applicationLabel: Record<string, string> = {
    done: "CANDIDATURE DÉJÀ ENVOYÉE",
    accepted: "candidature en brouillon, pas encore envoyée",
    proposed: "candidature préparée, en attente de son oui",
  };
  return rows
    .map(
      (r) =>
        `- [${r.category}, ${r.score}/100${r.status === "interested" ? ", aimé" : r.status === "urgent" ? ", coup de cœur urgent" : ""}` +
        `${r.application && applicationLabel[r.application] ? `, ${applicationLabel[r.application]}` : ""}] ${r.title}` +
        `${r.company ? ` chez ${r.company}` : ""}${r.location ? ` (${r.location})` : ""}${r.reason ? ` : ${r.reason}` : ""}`
    )
    .join("\n");
}
