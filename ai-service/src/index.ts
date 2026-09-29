import "dotenv/config";
import express from "express";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const internalSecret = process.env.INTERNAL_SECRET;
const geminiApiKey = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

// Raised from 2mb: chat requests can now carry image content (base64 data:
// URIs), and a conversation's history can include more than one.
app.use(express.json({ limit: "15mb" }));

// Defense in depth: even though this service has no published host port and
// is only reachable from other containers on the internal docker network,
// require a shared secret so a container escape or misconfigured network
// doesn't hand out free access to the Groq key.
app.use((req, res, next) => {
  if (!internalSecret) return next(); // no secret configured (local dev) — allow
  if (req.header("x-internal-secret") !== internalSecret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// Thin, generic passthrough to Gemini's OpenAI-compatible chat completions
// endpoint. All prompt assembly, tool definitions, tool execution, and
// conversation/memory persistence live in the backend — this service's only
// job is to hold the API key and forward whatever request shape it's given,
// unmodified except for sane defaults.
//
// Switched from Groq/gpt-oss-120b: its free tier caps at 8000 tokens/minute,
// too tight for a tool-calling agent (system prompt + memory + tool schemas
// + history + tool results all count against it every round of the loop) —
// kept hitting "Request too large" / rate-limit errors even after trimming
// every payload aggressively. Gemini's free tier has far more headroom.
// Model pinned to gemini-3.6-flash: gemini-2.5-flash returned 404 ("no
// longer available to new users") and gemini-3.8-flash (newest) has a very
// restrictive free tier (~20 requests/day) — 3.6 is the sweet spot. Same
// OpenAI-compatible request shape (reasoning_effort, max_completion_tokens,
// tools) so no changes needed on the backend side.
app.post("/chat", async (req, res) => {
  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${geminiApiKey}`,
      },
      body: JSON.stringify({
        model: "gemini-3.6-flash",
        reasoning_effort: "medium",
        // Gemini's reasoning tokens are billed out of this same budget, and
        // eat a large chunk of it before any visible text comes out (seen in
        // production: 1331 reasoning tokens vs. 713 visible ones on a single
        // reply) — 2048 was cutting off any answer needing real analysis
        // (finish_reason: "length"). Free-tier context has plenty of room.
        max_completion_tokens: 8192,
        ...req.body,
      }),
    });

    const data = await geminiRes.json();
    res.status(geminiRes.status).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur inattendue côté serveur." });
  }
});

app.listen(port, () => {
  console.log(`ai-service listening on port ${port}`);
  if (!geminiApiKey) {
    console.warn("GEMINI_API_KEY n'est pas définie — les requêtes échoueront.");
  }
});
