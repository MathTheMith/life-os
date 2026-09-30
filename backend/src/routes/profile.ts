import { Router } from "express";
import { db } from "../db.js";
import { callAiService } from "../aiClient.js";
import { listGoalsWithStats } from "./goals.js";

// The user's profile: who they are, what they dream of, what the AI should
// steer everything toward. It's written by the user (the AI can only
// suggest, or edit after an explicit yes) and goes first in every prompt.

export const PROFILE_SECTIONS = [
  {
    key: "qui_je_suis",
    title: "Qui je suis",
    hint: "Âge, études, situation, ce qui te définit.",
  },
  {
    key: "reves",
    title: "Mes rêves",
    hint: "Ce que tu veux vraiment vivre à long terme, même si ça paraît loin.",
  },
  {
    key: "objectifs",
    title: "Mes objectifs (1 à 2 ans)",
    hint: "Concrets et vérifiables : ce qui doit être vrai dans 1 à 2 ans.",
  },
  {
    key: "valeurs",
    title: "Mes valeurs et principes",
    hint: "Comment tu veux décider, ce qui compte pour toi, tes règles.",
  },
  {
    key: "contraintes",
    title: "Mes contraintes",
    hint: "Argent, temps, lieu, santé, tout ce qui limite les options.",
  },
  {
    key: "veille",
    title: "Ce que l'IA doit surveiller pour moi",
    hint: "Offres, régions, événements, bons plans, sujets d'actu qui t'intéressent.",
  },
] as const;

type SectionKey = (typeof PROFILE_SECTIONS)[number]["key"];
const SECTION_KEYS = PROFILE_SECTIONS.map((s) => s.key) as string[];

db.exec(`
  CREATE TABLE IF NOT EXISTS profile_sections (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function readContents(): Record<string, string> {
  const rows = db.prepare("SELECT key, content FROM profile_sections").all() as { key: string; content: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.content]));
}

export function setProfileSection(key: string, content: string) {
  if (!SECTION_KEYS.includes(key)) throw new Error(`Section inconnue : ${key}`);
  db.prepare(
    `INSERT INTO profile_sections (key, content, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
  ).run(key, content);
}

// Markdown block for system prompts; empty sections are left out.
export function getProfileForPrompt(): string {
  const contents = readContents();
  return PROFILE_SECTIONS.filter((s) => contents[s.key]?.trim())
    .map((s) => `### ${s.title}\n${contents[s.key].trim()}`)
    .join("\n\n");
}

export const profileRouter = Router();

profileRouter.get("/", (_req, res) => {
  const contents = readContents();
  res.json(PROFILE_SECTIONS.map((s) => ({ ...s, content: contents[s.key] ?? "" })));
});

profileRouter.put("/:key", (req, res) => {
  const content = typeof req.body?.content === "string" ? req.body.content : null;
  if (content === null) return res.status(400).json({ error: "content requis" });
  try {
    setProfileSection(req.params.key, content);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Read straight from the tables rather than through chatTools.ts, which
// imports this module (a cycle would break depending on load order).
function readSingleton(table: "assistant_memory" | "assistant_notes"): string {
  return (db.prepare(`SELECT content FROM ${table} WHERE id = 1`).get() as { content: string } | undefined)?.content ?? "";
}

// Drafts the sections from what Life OS already knows (memory, notes,
// goals). Returns the drafts without saving: the user reviews them first.
profileRouter.post("/draft", async (_req, res) => {
  const sources = [
    `## Mémoire globale\n${readSingleton("assistant_memory") || "(vide)"}`,
    `## Notes de l'assistant\n${readSingleton("assistant_notes") || "(vide)"}`,
    `## Objectifs suivis dans l'app\n${JSON.stringify(
      listGoalsWithStats().map((g: any) => ({ titre: g.title, type: g.kind, date: g.target_date }))
    )}`,
    `## Profil actuel (à améliorer, pas à écraser)\n${getProfileForPrompt() || "(vide)"}`,
  ].join("\n\n");

  const sectionList = PROFILE_SECTIONS.map((s) => `- "${s.key}" : ${s.title}. ${s.hint}`).join("\n");

  const prompt =
    "Rédige un brouillon du profil personnel de Mathéo, à la première personne (« je »), en français, " +
    "à partir UNIQUEMENT des sources ci-dessous. N'invente rien. Style : puces courtes et concrètes, pas de tirets cadratins. " +
    "Quand une information manque, termine la section par une ligne « À compléter : » suivie des questions à se poser.\n\n" +
    `Sections :\n${sectionList}\n\n` +
    'Réponds uniquement avec un objet JSON {"<clé>": "<texte de la section>", ...} contenant toutes les clés.\n\n' +
    sources;

  try {
    const data = await callAiService({ messages: [{ role: "user", content: prompt }] });
    const text: string = data.choices?.[0]?.message?.content ?? "";
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const drafts: Partial<Record<SectionKey, string>> = {};
    for (const key of SECTION_KEYS) {
      if (typeof parsed[key] === "string") drafts[key as SectionKey] = (parsed[key] as string).trim();
    }
    res.json(drafts);
  } catch (err) {
    console.error("Erreur brouillon profil:", err);
    res.status(502).json({ error: "Impossible de générer le brouillon, réessaie." });
  }
});
