import { htmlToText } from "html-to-text";

// Real search needs a search engine's API. Tavily over Brave: Brave killed
// its free tier in Feb 2026 (now needs a card for metered credits), while
// Tavily gives 1000 req/month free with no card, and is built specifically
// for AI agents — results come back as clean content snippets meant to be
// read by a model, not a results page meant to be clicked through.
// Reading a specific page (the other half of "internet access") needs no
// key at all, so that one works regardless of whether TAVILY_API_KEY is set.
const SEARCH_URL = "https://api.tavily.com/search";
const MAX_PAGE_CHARS = 6000;
const FETCH_TIMEOUT_MS = 10_000;

// Blocks the obvious ways a page's content could trick the model into
// making this server fetch its own internal services (bank sync, ai-service,
// ...) — not watertight against DNS rebinding, but this app has no other
// network-level boundary either, so it matches its existing posture rather
// than pretending to be a hardened fetcher.
const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|::1|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/i;

function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL invalide.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Seuls les liens http(s) sont supportés.");
  if (BLOCKED_HOSTS.test(url.hostname)) throw new Error("Cette adresse n'est pas accessible depuis ici.");
  return url;
}

/**
 * Fetches a page and returns its readable text — the model's only way to
 * actually see what's behind a link it has (from a mail, a job posting...).
 * No search involved, no key needed.
 */
export async function fetchPageText(raw: string): Promise<{ title: string; url: string; text: string }> {
  const url = assertFetchableUrl(raw);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LifeOsBot/1.0)" },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Page inaccessible : ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`La page a répondu ${res.status}.`);
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html") && !contentType.includes("text/plain")) {
    throw new Error(`Type de contenu non lisible : ${contentType || "inconnu"}.`);
  }
  const html = await res.text();
  const text = htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  })
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_PAGE_CHARS);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || url.hostname;
  return { title, url: url.toString(), text };
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Real web search (finding pages the model doesn't already have a link to),
 * unlike fetchPageText above. Requires TAVILY_API_KEY — without it this
 * throws a clear, actionable error instead of silently doing nothing.
 */
export async function searchWeb(query: string): Promise<WebSearchResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error("Recherche web non configurée (TAVILY_API_KEY manquant côté serveur).");

  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, max_results: 6 }),
  });
  if (!res.ok) throw new Error(`Recherche web : l'API a répondu ${res.status}.`);
  const data = (await res.json()) as any;
  const results = (data.results ?? []) as any[];
  return results.slice(0, 6).map((r) => ({
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    snippet: String(r.content ?? ""),
  }));
}
