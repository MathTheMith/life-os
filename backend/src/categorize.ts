import { db } from "./db.js";

export function categorize(label: string): string {
  const normalized = label.toLowerCase();
  const rules = db
    .prepare("SELECT keyword, category FROM category_rules")
    .all() as { keyword: string; category: string }[];

  for (const rule of rules) {
    if (normalized.includes(rule.keyword)) {
      return rule.category;
    }
  }
  return "autre";
}

/**
 * Resolves the final category for an imported row using our own keyword
 * rules only. Used to mint a `banque_${slug}` category straight out of the
 * bank's own raw category string as a fallback — sounds reasonable, but in
 * practice it fragmented the whole history into 35+ near-meaningless
 * buckets (e.g. "banque_hyper_supermarche" instead of "alimentation"), and
 * several of the bank's own labels are literally "à catégoriser" (the bank
 * itself hasn't classified it yet) — those got accepted as if they were a
 * real category. `bankCategory` is kept as a parameter (unused here) so
 * call sites don't need to change; they now pass it to categorizeBatchWithAI
 * instead, as a hint the model can use without it ever becoming a category
 * of its own.
 */
export function categorizeWithFallback(label: string, _bankCategory?: string): string {
  return categorize(label);
}

// Bank noise words and generic payment-processor brands (used by many
// unrelated merchants — a SumUp terminal shows up for a food truck just as
// much as a hairdresser, so it must never become a learned keyword) to skip
// when guessing a merchant name out of a raw label.
const KEYWORD_NOISE = new Set([
  "cb",
  "fact",
  "carte",
  "prlv",
  "vir",
  "sepa",
  "paiement",
  "sumup",
  "paypal",
  "stripe",
  "izettle",
  "zettle",
]);

/**
 * Best-effort merchant keyword out of a raw bank label, so a manual
 * recategorization can seed a category_rules row and save you from doing it
 * again next time the same merchant shows up. Deliberately conservative:
 * strips digit runs (dates, card numbers), noise/processor words, and short
 * fragments, then takes the first word left — "autre" if nothing usable
 * remains, so no rule is created rather than a guessed bad one.
 */
export function extractKeyword(label: string): string | null {
  const words = label
    .toLowerCase()
    .replace(/\d{6,}/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !KEYWORD_NOISE.has(w));
  return words[0] ?? null;
}
