// Shared client for every model call (chat, brief, watch, mail triage,
// categorization...). Everything goes to the Claude bridge running on the
// host (see claude-bridge/server.mjs).

const claudeCompleteUrl = (process.env.CLAUDE_BRIDGE_URL || "http://172.28.1.1:4200/ask").replace(/\/ask$/, "/complete");
const CLAUDE_TIMEOUT_MS = 160_000;

export async function completeWithClaude(prompt: string, image?: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLAUDE_TIMEOUT_MS);
  try {
    const res = await fetch(claudeCompleteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, image }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { content?: string; error?: string };
    if (!res.ok || data.error) throw new Error(data.error || `Le pont Claude a répondu ${res.status}.`);
    return data.content ?? "";
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("Claude n'a pas répondu à temps.");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

type Part = { type: string; text?: string; image_url?: { url: string } };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as Part[]).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
  return "";
}

function imageOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  return (content as Part[]).find((p) => p.type === "image_url")?.image_url?.url;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// Turns an OpenAI-style conversation (with tool calls and tool results) into
// one plain-text prompt, since the bridge is a one-shot text call.
function flatten(messages: any[]): { system: string; transcript: string; image?: string } {
  const system: string[] = [];
  const turns: string[] = [];
  const toolNames = new Map<string, string>();
  let image: string | undefined;
  for (const m of messages) {
    const text = textOf(m.content);
    image = imageOf(m.content) ?? image;
    if (m.role === "system") system.push(text);
    else if (m.role === "user") turns.push(`[Mathéo]\n${text}`);
    else if (m.role === "assistant" && m.tool_calls?.length) {
      for (const c of m.tool_calls) toolNames.set(c.id, c.function.name);
      const calls = m.tool_calls.map((c: any) => ({ name: c.function.name, arguments: parseArgs(c.function.arguments) }));
      turns.push(`[Toi, appel d'outil]\n${JSON.stringify(calls)}`);
    } else if (m.role === "assistant") turns.push(`[Toi]\n${text}`);
    else if (m.role === "tool") turns.push(`[Résultat de l'outil ${toolNames.get(m.tool_call_id) ?? "inconnu"}]\n${text}`);
  }
  return { system: system.join("\n\n"), transcript: turns.join("\n\n"), image };
}

function toolsInstructions(tools: any[]): string {
  const list = tools
    .map((t) => `- ${t.function.name} : ${t.function.description}\n  Paramètres (JSON schema) : ${JSON.stringify(t.function.parameters)}`)
    .join("\n");
  return (
    "Tu peux utiliser ces outils pour lire ou modifier les données de Mathéo :\n" +
    list +
    "\n\nPour utiliser un ou plusieurs outils, réponds UNIQUEMENT avec un objet JSON : " +
    '{"tool_calls":[{"name":"nom_outil","arguments":{...}}]}. ' +
    'Pour répondre à Mathéo, réponds UNIQUEMENT avec un objet JSON : {"content":"ta réponse"}. ' +
    "Aucun texte en dehors de ce JSON. Après un appel d'outil, tu recevras ses résultats et tu continueras."
  );
}

function tryParseObject(raw: string): any | null {
  try {
    return parseJsonReply(raw);
  } catch {
    return null;
  }
}

async function callClaude(body: { messages?: any[]; tools?: any[] }): Promise<any> {
  const tools = body.tools ?? [];
  const { system, transcript, image } = flatten(body.messages ?? []);
  const prompt = [system, tools.length ? toolsInstructions(tools) : "", transcript && `---\n${transcript}`, "Ta réponse maintenant :"]
    .filter(Boolean)
    .join("\n\n");
  const raw = await completeWithClaude(prompt, image);

  if (!tools.length) return { choices: [{ message: { role: "assistant", content: raw } }] };
  const parsed = tryParseObject(raw);
  if (Array.isArray(parsed?.tool_calls) && parsed.tool_calls.length) {
    const tool_calls = parsed.tool_calls.map((c: any, i: number) => ({
      id: `call_${Date.now()}_${i}`,
      type: "function",
      function: { name: String(c.name), arguments: JSON.stringify(c.arguments ?? {}) },
    }));
    return { choices: [{ message: { role: "assistant", content: null, tool_calls } }] };
  }
  const content = typeof parsed?.content === "string" ? parsed.content : raw;
  return { choices: [{ message: { role: "assistant", content } }] };
}

export async function callAiService(body: any): Promise<any> {
  return callClaude(body);
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
