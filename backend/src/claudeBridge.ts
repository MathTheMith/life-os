// Routes a chat message to the real Claude Code CLI instead of Gemini, for
// code questions or research Mathéo specifically wants Claude (not the
// everyday assistant) to handle. The CLI itself runs on the host, not in
// this container — see claude-bridge/server.mjs for why and how.
const BRIDGE_TIMEOUT_MS = 155_000;

export function isClaudeTrigger(message: string): boolean {
  return /\bclaude\b/i.test(message);
}

export async function askClaudeBridge(message: string): Promise<string> {
  const url = process.env.CLAUDE_BRIDGE_URL;
  if (!url) throw new Error("Pont Claude Code non configuré (CLAUDE_BRIDGE_URL manquant).");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { reply?: string; error?: string };
    if (!res.ok || data.error) throw new Error(data.error || `Le pont a répondu ${res.status}.`);
    return data.reply || "(réponse vide)";
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new Error("Claude n'a pas répondu à temps.");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
