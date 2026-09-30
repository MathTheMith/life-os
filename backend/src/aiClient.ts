// Shared client for the ai-service container (the only place holding the
// model API key). Used by the chat, and by any background job that needs
// the model (profile drafts, brief, watch).

const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:4000";
const internalSecret = process.env.INTERNAL_SECRET;

// Gemini's OpenAI-compat layer sometimes wraps errors in an array
// ([{ error: {...} }]) instead of a plain object ({ error: {...} }) — handle
// both shapes rather than silently falling back to a useless generic message.
function extractErrorMessage(data: any): string | undefined {
  const errorObj = Array.isArray(data) ? data[0]?.error : data?.error;
  return typeof errorObj === "string" ? errorObj : errorObj?.message;
}

// 429 (per-minute quota) names the exact remaining wait ("Please try again
// in 5.8875s") when the provider is Groq; 503 (Gemini's transient "model
// overloaded") doesn't, so this just falls back to a short fixed wait.
function parseRetryAfterMs(message: string): number {
  const match = message.match(/try again in ([\d.]+)s/i);
  const seconds = match ? Number.parseFloat(match[1]) : 3;
  return Math.ceil(seconds * 1000) + 500;
}

export async function callAiService(body: unknown, attempt = 0): Promise<any> {
  const response = await fetch(`${aiServiceUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(internalSecret ? { "x-internal-secret": internalSecret } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();

  const isRetryable = response.status === 429 || response.status === 503;
  if (isRetryable && attempt < 2) {
    await new Promise((resolve) => setTimeout(resolve, parseRetryAfterMs(extractErrorMessage(data) || "")));
    return callAiService(body, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(extractErrorMessage(data) || `ai-service a répondu ${response.status}`);
  }
  return data;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", laquo: "«", raquo: "»", hellip: "…",
  eacute: "é", egrave: "è", ecirc: "ê", agrave: "à", acirc: "â", ccedil: "ç", ugrave: "ù", ocirc: "ô", icirc: "î", euro: "€",
};

// The model sometimes HTML-escapes its JSON strings ("Systems &amp; Networks").
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function decodeDeep(value: unknown): unknown {
  if (typeof value === "string") return decodeEntities(value);
  if (Array.isArray(value)) return value.map(decodeDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decodeDeep(v)]));
  }
  return value;
}

// Pulls the JSON object out of a model reply and cleans its strings.
export function parseJsonReply(raw: string): any {
  return decodeDeep(JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)));
}
