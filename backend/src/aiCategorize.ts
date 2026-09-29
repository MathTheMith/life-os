import { db } from "./db.js";

const aiServiceUrl = process.env.AI_SERVICE_URL || "http://localhost:4000";
const internalSecret = process.env.INTERNAL_SECRET;

// Fixed palette (categoryStyle.ts on the frontend) plus whatever's been
// learned since — the model picks from this closed set instead of
// inventing new categories on the fly, so "autre" stays the one legitimate
// "I don't know" answer instead of a slow drift into near-duplicate labels.
const BASE_CATEGORIES = [
  "alimentation",
  "transport",
  "motorsport",
  "loisirs",
  "abonnements",
  "logement",
  "revenus",
  "shopping",
];

function knownCategories(): string[] {
  const learned = (db.prepare("SELECT DISTINCT category FROM category_rules").all() as { category: string }[]).map(
    (r) => r.category
  );
  return [...new Set([...BASE_CATEGORIES, ...learned])];
}

export interface UncategorizedItem {
  label: string;
  amount: number;
  // The bank's own raw category text (e.g. "Hyper/Supermarché"), when it
  // has one — a strong hint for the model, but never turned into a
  // category by itself (see categorize.ts for why).
  bankCategory?: string;
}

/**
 * Categorizes whatever the keyword rules couldn't place, in one batched
 * call (not one per transaction — import-all runs every 4h and a chat
 * question shouldn't compete with it for the same free-tier quota). Falls
 * back to null per item (caller keeps "autre") on any failure — a
 * mis-categorization the model itself flags as uncertain, a network error,
 * or a malformed response all fail the same safe way: nothing worse than
 * what happened before this existed.
 */
export async function categorizeBatchWithAI(items: UncategorizedItem[]): Promise<(string | null)[]> {
  if (items.length === 0) return [];
  const categories = knownCategories();
  const prompt =
    `Catégorise chacune de ces transactions bancaires françaises dans UNE des catégories suivantes, exactement : ${categories.join(", ")}. ` +
    `Un montant positif est une rentrée d'argent (revenus, remboursement...), un montant négatif une dépense. ` +
    `Si aucune catégorie ne convient clairement, réponds "autre" pour cette ligne — n'invente jamais une nouvelle catégorie. ` +
    `Réponds UNIQUEMENT avec un tableau JSON de ${items.length} chaînes de caractères, dans le même ordre que la liste, sans aucun texte autour.\n\n` +
    items
      .map(
        (it, i) =>
          `${i + 1}. ${it.amount > 0 ? "+" : ""}${it.amount.toFixed(2)}€ — ${it.label}` +
          (it.bankCategory ? ` (catégorie donnée par la banque : ${it.bankCategory})` : "")
      )
      .join("\n");

  try {
    const res = await fetch(`${aiServiceUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(internalSecret ? { "x-internal-secret": internalSecret } : {}),
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        reasoning_effort: "low",
        // Gemini's reasoning tokens are billed out of this same budget and
        // eat a chunk of it before any visible output — 1024 was cutting
        // the JSON array off mid-string on a full batch (~30 items) and
        // silently sending everything in it to "autre". A single import run
        // rarely has more than a handful of uncategorized rows, so this is
        // still cheap in practice.
        max_completion_tokens: 4096,
      }),
    });
    const data = (await res.json()) as any;
    if (!res.ok) throw new Error(JSON.stringify(data));

    const text: string = data.choices?.[0]?.message?.content ?? "";
    const match = text.match(/\[[\s\S]*\]/);
    const parsed = match ? JSON.parse(match[0]) : null;
    if (!Array.isArray(parsed) || parsed.length !== items.length) {
      console.error("Catégorisation IA: réponse inattendue, repli sur 'autre':", text.slice(0, 200));
      return items.map(() => null);
    }
    return parsed.map((c) => (typeof c === "string" && categories.includes(c) ? c : null));
  } catch (err) {
    console.error("Catégorisation IA échouée, repli sur 'autre':", (err as Error).message);
    return items.map(() => null);
  }
}
