import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { getBudgetSummary } from "./routes/budget.js";
import { listEnvelopesWithSummary } from "./routes/envelope.js";
import { listGoalsWithStats } from "./routes/goals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// OpenAI-compatible tool schemas (Groq's chat completions API uses the same
// "tools" shape). Read tools let the model pull exactly the data a question
// needs instead of working off one fixed snapshot — the fix for imprecise
// answers on anything outside "this month". Write tools update memory, and
// are only ever called after the user has explicitly said yes (enforced via
// the system prompt instructions, not code — there's no way to verify
// "explicit yes" mechanically).
const READ_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_budget_summary",
      description:
        "Récupère le résumé budgétaire d'un mois : revenus, dépenses, solde, et répartition par catégorie (dépenses et rentrées séparément).",
      parameters: {
        type: "object",
        properties: {
          // Nullable, not just optional: Groq's strict tool-call validation
          // rejects the call outright if the model passes JSON null for a
          // plain "string" param (which it does whenever it omits an
          // argument it considers not needed) — seen in production logs as
          // "expected string, but got null". Allowing null keeps that a
          // valid call instead of a hard failure.
          month: { type: ["string", "null"], description: "Mois au format YYYY-MM. Si omis (null), le mois en cours." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_transactions",
      description: "Liste des transactions, filtrable par mois et/ou catégorie. Utile pour répondre à une question précise sur une dépense ou une période donnée.",
      parameters: {
        type: "object",
        properties: {
          month: { type: ["string", "null"], description: "YYYY-MM, ou null pour ne pas filtrer par mois." },
          category: { type: ["string", "null"], description: "Catégorie exacte, ou null pour ne pas filtrer par catégorie." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_envelopes",
      description: "État des enveloppes budgétaires (ex: Motorsport) : dépensé, restant, rythme, projection.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_goals",
      description: "Objectifs ponctuels et habitudes récurrentes, avec statut, séries de jours (streak) et historique des 7 derniers jours.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_races",
      description: "Carnet de performance : courses, qualifs, chronos, positions.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_todos",
      description: "Liste des tâches à faire (todo list générale, pas les objectifs motorsport), avec leur statut.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_bank_connections",
      description:
        "État de la synchronisation bancaire : banques connectées, comptes associés, date d'expiration du consentement (valid_until) et date de dernière synchro par compte.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_motorsport_plan",
      description:
        "Contenu complet et détaillé du document 'état des lieux' du plan motorsport de Mathéo (objectifs, budget nécessaire, timeline, étapes) — plus complet que le résumé condensé dans la mémoire globale. À utiliser pour toute question précise sur le plan qui dépasse ce que la mémoire globale résume.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const UPDATE_GLOBAL_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "update_global_memory",
    description:
      "Met à jour la mémoire globale, partagée entre TOUTES les conversations. N'appeler que si l'utilisateur a explicitement dit oui / demandé de retenir ou changer quelque chose. Fournir le contenu complet mis à jour (pas juste l'ajout).",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Contenu complet et mis à jour de la mémoire globale." },
      },
      required: ["content"],
    },
  },
};

const UPDATE_CHAT_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "update_chat_memory",
    description:
      "Met à jour la mémoire propre à CETTE conversation uniquement (pas partagée avec les autres). N'appeler que si l'utilisateur a explicitement dit oui / demandé de retenir ou changer quelque chose. Fournir le contenu complet mis à jour.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Contenu complet et mis à jour de la mémoire de cette conversation." },
      },
      required: ["content"],
    },
  },
};

const MAX_ASSISTANT_NOTES_CHARS = 2000;

const UPDATE_ASSISTANT_NOTES_TOOL = {
  type: "function",
  function: {
    name: "update_assistant_notes",
    description:
      `Met à jour TES notes personnelles (ta propre mémoire, partagée entre toutes les conversations). Tu peux l'appeler seul, sans demander la permission, dès que tu remarques quelque chose d'utile à retenir sur Mathéo, sa façon de travailler ou ce qui marche/ne marche pas avec lui. Fournir le contenu complet mis à jour (fusionne avec l'existant, supprime ce qui est obsolète). Maximum ${MAX_ASSISTANT_NOTES_CHARS} caractères : sois bref et condense.`,
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Contenu complet et mis à jour de tes notes." },
      },
      required: ["content"],
    },
  },
};

export function toolDefinitions(hasChatMemory: boolean) {
  return hasChatMemory
    ? [...READ_TOOLS, UPDATE_GLOBAL_MEMORY_TOOL, UPDATE_CHAT_MEMORY_TOOL, UPDATE_ASSISTANT_NOTES_TOOL]
    : [...READ_TOOLS, UPDATE_GLOBAL_MEMORY_TOOL, UPDATE_ASSISTANT_NOTES_TOOL];
}

// No LIMIT: Gemini's context window has plenty of headroom for the full
// transaction history, and a capped result silently hid older data from the
// model. Excludes internal transfers, same as the rest of the app treats
// them as non-spending.
function getTransactions(month?: string, category?: string) {
  const conditions: string[] = ["is_excluded = 0"];
  const params: string[] = [];
  if (month) {
    conditions.push("date LIKE ?");
    params.push(`${month}%`);
  }
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }
  return db
    .prepare(
      `SELECT date, label, amount, category FROM transactions WHERE ${conditions.join(" AND ")} ORDER BY date DESC`
    )
    .all(...params);
}

function getBankConnections() {
  const connections = db.prepare("SELECT * FROM bank_connections ORDER BY created_at DESC").all() as {
    id: number;
  }[];
  const accountsStmt = db.prepare(
    "SELECT id, uid, iban, name, last_synced_at FROM bank_accounts WHERE connection_id = ?"
  );
  return connections.map((c) => ({ ...c, accounts: accountsStmt.all(c.id) }));
}

let motorsportPlanCache: string | undefined;
function getMotorsportPlan(): string {
  if (motorsportPlanCache === undefined) {
    const planPath = path.join(__dirname, "..", "assets", "motorsport-plan.md");
    motorsportPlanCache = fs.readFileSync(planPath, "utf8");
  }
  return motorsportPlanCache;
}

export function executeTool(
  name: string,
  args: Record<string, unknown>,
  conversationId: number | null
): string {
  try {
    switch (name) {
      case "get_budget_summary":
        return JSON.stringify(getBudgetSummary((args.month as string) || new Date().toISOString().slice(0, 7)));
      case "get_transactions":
        return JSON.stringify(getTransactions(args.month as string | undefined, args.category as string | undefined));
      case "get_envelopes":
        return JSON.stringify(listEnvelopesWithSummary());
      case "get_goals":
        return JSON.stringify(listGoalsWithStats());
      case "get_races":
        return JSON.stringify(db.prepare("SELECT * FROM race_logs ORDER BY date DESC, id DESC").all());
      case "get_todos":
        return JSON.stringify(db.prepare("SELECT * FROM todos ORDER BY done ASC, created_at DESC").all());
      case "get_bank_connections":
        return JSON.stringify(getBankConnections());
      case "get_motorsport_plan":
        return getMotorsportPlan();
      case "update_global_memory":
        db.prepare("UPDATE assistant_memory SET content = ? WHERE id = 1").run(String(args.content ?? ""));
        return JSON.stringify({ ok: true });
      case "update_chat_memory":
        if (!conversationId) {
          return JSON.stringify({ error: "Mémoire de conversation indisponible (conversation temporaire)." });
        }
        db.prepare("UPDATE conversations SET memory = ? WHERE id = ?").run(String(args.content ?? ""), conversationId);
        return JSON.stringify({ ok: true });
      case "update_assistant_notes": {
        const content = String(args.content ?? "");
        if (content.length > MAX_ASSISTANT_NOTES_CHARS) {
          return JSON.stringify({
            error: `Notes trop longues (${content.length} > ${MAX_ASSISTANT_NOTES_CHARS} caractères). Condense et réessaie.`,
          });
        }
        db.prepare("UPDATE assistant_notes SET content = ? WHERE id = 1").run(content);
        return JSON.stringify({ ok: true });
      }
      default:
        return JSON.stringify({ error: `Outil inconnu: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
}

export function getGlobalMemory(): string {
  const row = db.prepare("SELECT content FROM assistant_memory WHERE id = 1").get() as { content: string };
  return row.content;
}

export function getAssistantNotes(): string {
  const row = db.prepare("SELECT content FROM assistant_notes WHERE id = 1").get() as { content: string };
  return row.content;
}
