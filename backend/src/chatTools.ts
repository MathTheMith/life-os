import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./db.js";
import { getBudgetSummary } from "./routes/budget.js";
import { listEnvelopesWithSummary } from "./routes/envelope.js";
import { listGoalsWithStats } from "./routes/goals.js";
import { PROFILE_SECTIONS, setProfileSection } from "./routes/profile.js";
import { listJournal } from "./routes/journal.js";
import { addEvent, updateEvent, deleteEvent, listAgenda } from "./routes/agenda.js";
import { listMails } from "./mail.js";

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
      name: "get_journal",
      description:
        "Entrées du journal de Mathéo (issues de ses chats du soir) : date, texte complet, humeur et énergie sur 5, résumé, faits retenus. Les 14 derniers jours sont déjà résumés dans le contexte : n'utilise cet outil que pour remonter plus loin ou lire le détail.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Nombre de jours à remonter (défaut 30)." },
        },
      },
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

const AGENDA_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_agenda",
      description: "Événements de l'agenda entre deux dates (AAAA-MM-JJ). Les 3 prochaines semaines sont déjà dans le contexte.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Date de début AAAA-MM-JJ." },
          to: { type: "string", description: "Date de fin AAAA-MM-JJ." },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_agenda_event",
      description:
        "Ajoute un événement ou un rappel à l'agenda de Mathéo. À utiliser sans demander dès qu'il mentionne un rendez-vous, une échéance, une course ou demande un rappel.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Titre court et clair." },
          start: { type: "string", description: "AAAA-MM-JJTHH:MM (heure de Paris), ou AAAA-MM-JJ pour une journée entière." },
          end: { type: "string", description: "Fin, même format (optionnel)." },
          notes: { type: "string", description: "Détails utiles (optionnel)." },
          remind_before_min: { type: "number", description: "Minutes avant le début pour le rappel (défaut 60)." },
        },
        required: ["title", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_agenda_event",
      description: "Modifie un événement existant (id visible dans l'agenda du contexte). Fournir tous les champs à jour.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number" },
          title: { type: "string" },
          start: { type: "string" },
          end: { type: "string" },
          notes: { type: "string" },
          remind_before_min: { type: "number" },
        },
        required: ["id", "title", "start"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_agenda_event",
      description: "Supprime un événement de l'agenda (quand il est annulé ou que Mathéo le demande).",
      parameters: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_mails",
      description:
        "Mails reçus par Mathéo, déjà triés par l'IA (importance, catégorie, résumé, action). Les importants des 3 derniers jours sont déjà dans le contexte.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "Nombre de jours à remonter (défaut 14)." },
          min_importance: { type: "number", description: "Importance minimale sur 100 (défaut 0)." },
        },
      },
    },
  },
];

const UPDATE_PROFILE_SECTION_TOOL = {
  type: "function",
  function: {
    name: "update_profile_section",
    description:
      "Remplace le contenu d'une section du profil de Mathéo (ses rêves, objectifs, valeurs...). N'appeler que si Mathéo a explicitement dit oui à la modification proposée. Fournir le texte complet de la section, pas juste l'ajout.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", enum: PROFILE_SECTIONS.map((s) => s.key), description: "Section à modifier." },
        content: { type: "string", description: "Texte complet et mis à jour de la section." },
      },
      required: ["key", "content"],
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
    ? [...READ_TOOLS, ...AGENDA_TOOLS, UPDATE_PROFILE_SECTION_TOOL, UPDATE_GLOBAL_MEMORY_TOOL, UPDATE_CHAT_MEMORY_TOOL, UPDATE_ASSISTANT_NOTES_TOOL]
    : [...READ_TOOLS, ...AGENDA_TOOLS, UPDATE_PROFILE_SECTION_TOOL, UPDATE_GLOBAL_MEMORY_TOOL, UPDATE_ASSISTANT_NOTES_TOOL];
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
      case "get_agenda":
        return JSON.stringify(listAgenda(String(args.from), String(args.to)));
      case "add_agenda_event": {
        const { event, created } = addEvent({ ...(args as any), source: "chat" });
        return JSON.stringify({ ok: true, created, event });
      }
      case "update_agenda_event": {
        const event = updateEvent(Number(args.id), args as any);
        return JSON.stringify(event ? { ok: true, event } : { error: "Événement introuvable." });
      }
      case "delete_agenda_event":
        deleteEvent(Number(args.id));
        return JSON.stringify({ ok: true });
      case "get_mails":
        return JSON.stringify(listMails(Number(args.days) > 0 ? Number(args.days) : 14, Number(args.min_importance) || 0));
      case "get_journal":
        return JSON.stringify(listJournal(Number(args.days) > 0 ? Number(args.days) : 30));
      case "get_motorsport_plan":
        return getMotorsportPlan();
      case "update_profile_section":
        setProfileSection(String(args.key ?? ""), String(args.content ?? ""));
        return JSON.stringify({ ok: true });
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
