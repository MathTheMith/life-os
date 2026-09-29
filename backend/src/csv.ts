import { parse } from "csv-parse/sync";

export interface ParsedTransaction {
  date: string;
  label: string;
  amount: number;
  /** Category the bank itself assigned, if the export includes one — used as a
   *  fallback when our own keyword rules don't recognize the merchant. */
  bankCategory?: string;
  /**
   * True when the bank itself flags this row as not real income/spending —
   * e.g. a transfer between the user's own accounts (checking → savings).
   * These move money between the user's own pockets and must be excluded
   * from income/expense totals, or a transfer to a personal savings account
   * inflates "spending" and a transfer back inflates "income".
   */
  isExcluded: boolean;
}

/**
 * Many French bank exports use ISO-8859-1 / Windows-1252 rather than UTF-8.
 * Decoding those bytes as UTF-8 corrupts every accented character instead of
 * throwing, so we can't rely on an exception — check for the replacement
 * character (U+FFFD) that UTF-8 decoding inserts for invalid byte sequences
 * and fall back to latin1 when it shows up.
 */
export function decodeCsvBuffer(buffer: Buffer): string {
  const asUtf8 = buffer.toString("utf-8");
  if (asUtf8.includes("�")) {
    return buffer.toString("latin1");
  }
  return asUtf8;
}

function findColumn(headers: string[], candidates: string[]): string | undefined {
  const lower = headers.map((h) => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = lower.findIndex((h) => h.includes(candidate));
    if (idx !== -1) return headers[idx];
  }
  return undefined;
}

/** Finds the main "Categorie" column specifically, as distinct from
 *  "Sous categorie" — both contain the substring "categorie", so a plain
 *  `.includes()` match would pick whichever comes first in the file and
 *  can't tell them apart. */
function findExactColumn(headers: string[], exactNames: string[]): string | undefined {
  return headers.find((h) => exactNames.includes(h.toLowerCase().trim()));
}

/**
 * Normalizes dates to ISO (YYYY-MM-DD) so month filtering (`LIKE 'YYYY-MM%'`)
 * and chronological sorting work regardless of the source format. French
 * bank exports use DD/MM/YYYY; already-ISO dates pass through unchanged.
 */
function normalizeDate(raw: string): string {
  const frenchMatch = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (frenchMatch) {
    const [, day, month, year] = frenchMatch;
    return `${year}-${month}-${day}`;
  }
  return raw.trim();
}

/**
 * Detects whether the file uses `;` (French bank exports, comma as decimal
 * separator) or `,` (standard CSV, period as decimal separator) by counting
 * occurrences on the header line only — never sniff a data row, since a
 * French amount like "16,14" contains a comma that isn't a delimiter.
 *
 * This matters a lot: passing csv-parse an array of candidate delimiters
 * makes it treat every one of them as an active delimiter simultaneously,
 * not "try each and pick one". With `[",", ";"]`, a semicolon-delimited row
 * containing "-16,14" gets split into "-16" and "14" as if they were two
 * separate columns — silently truncating every decimal amount to its
 * integer part and shifting every column after it. Always resolve to a
 * single delimiter before calling parse().
 */
function detectDelimiter(fileContent: string): "," | ";" {
  const headerLine = fileContent.split(/\r?\n/, 1)[0] ?? "";
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return semicolons >= commas ? ";" : ",";
}

function parseFrenchNumber(raw: string): number {
  const cleaned = raw
    .replace(/\s/g, "")
    .replace(/[€$]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const value = Number.parseFloat(cleaned);
  return Number.isNaN(value) ? 0 : value;
}

function parseNumber(raw: string, delimiter: "," | ";"): number {
  if (delimiter === ";") return parseFrenchNumber(raw);
  // Comma-delimited file: comma is already consumed as the field separator,
  // so amounts inside a field can only use a period for decimals.
  const cleaned = raw.replace(/\s/g, "").replace(/[€$]/g, "");
  const value = Number.parseFloat(cleaned);
  return Number.isNaN(value) ? 0 : value;
}

/**
 * Parses common French bank CSV exports. Column names vary by bank, so this
 * auto-detects date/label/amount (or separate debit/credit) columns instead
 * of assuming a fixed schema.
 */
export function parseBankCsv(fileContent: string): ParsedTransaction[] {
  const delimiter = detectDelimiter(fileContent);
  const records: Record<string, string>[] = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    delimiter,
    relax_column_count: true,
    trim: true,
  });

  if (records.length === 0) return [];

  const headers = Object.keys(records[0]);
  // Prefer "Date operation" (when the transaction actually happened) over a
  // generic "date" match, which would land on "Date de comptabilisation"
  // (bank processing/posting date — can lag the real date by a few days,
  // shifting a transaction into the wrong month at month boundaries). Falls
  // back to whatever "date" column exists for banks with a single date field.
  const dateCol = findColumn(headers, ["date operation", "date de l'operation", "date"]);
  const labelCol = findColumn(headers, ["libell", "label", "description", "intitul"]);
  const amountCol = findColumn(headers, ["montant", "amount"]);
  const debitCol = findColumn(headers, ["debit", "débit"]);
  const creditCol = findColumn(headers, ["credit", "crédit"]);
  const mainCategorieCol = findExactColumn(headers, ["categorie", "category", "catégorie"]);
  const sousCategorieCol = findColumn(headers, ["sous categorie", "sous-categorie", "sous catégorie"]);
  const bankCategoryCol = sousCategorieCol ?? mainCategorieCol;

  if (!dateCol || !labelCol || (!amountCol && !debitCol && !creditCol)) {
    throw new Error(
      "Colonnes non reconnues. Attendu au minimum : date, libellé, et montant (ou débit/crédit)."
    );
  }

  const parsed = records.map((row) => {
    let amount = 0;
    if (amountCol) {
      amount = parseNumber(row[amountCol] ?? "0", delimiter);
    } else {
      const debit = debitCol ? parseNumber(row[debitCol] || "0", delimiter) : 0;
      const credit = creditCol ? parseNumber(row[creditCol] || "0", delimiter) : 0;
      amount = credit - Math.abs(debit);
    }
    const bankCategory = bankCategoryCol ? row[bankCategoryCol]?.trim() : undefined;

    const mainCategorie = mainCategorieCol ? row[mainCategorieCol]?.trim().toLowerCase() : "";
    const sousCategorie = sousCategorieCol ? row[sousCategorieCol]?.trim().toLowerCase() : "";
    // "Transaction exclue" is this bank's own explicit flag for "don't count
    // this in budget totals" (transfers between the user's own accounts).
    // "virement interne" is a fallback heuristic for banks that don't use
    // that exact wording but do label internal transfers explicitly.
    //
    // Word-boundary regex, not .includes(): a plain substring check on
    // "interne" also matches "Internet et telephonie" — "internet" contains
    // "interne" as a literal substring — which would wrongly exclude every
    // phone bill from expense totals. \b requires "interne" to end at a
    // word boundary, which "internet" never does (the "t" right after keeps
    // it inside the same word).
    const internePattern = /\binterne\b/;
    const excluPattern = /\bexclu/;
    const isExcluded =
      excluPattern.test(mainCategorie) ||
      internePattern.test(sousCategorie) ||
      internePattern.test(mainCategorie);

    return {
      date: normalizeDate(row[dateCol]),
      label: row[labelCol],
      amount,
      bankCategory: bankCategory || undefined,
      isExcluded,
      _sousCategorie: sousCategorie,
    };
  });

  markCancellingPairs(parsed);

  return parsed.map(({ _sousCategorie, ...rest }) => rest);
}

/**
 * A recurring bank-card fee that's partially rebated the same day (e.g.
 * -7.60€ charge, +4.60€ rebate) is a real ~-3€/month cost and must stay in
 * the totals. But an occasional charge that's *fully* reversed the same day
 * (e.g. an annual fee waived in full: -23.70€ then +23.70€) is a wash, not
 * real income or spending — same idea as an internal transfer, just not
 * flagged by the bank's Categorie column. Detect it structurally instead:
 * exactly two rows, same date, same sub-category, amounts summing to ~0.
 * Deliberately narrow (same day *and* same sub-category *and* exact
 * cancellation) to keep the odds of coincidentally cancelling unrelated
 * transactions effectively at zero.
 */
function markCancellingPairs(
  rows: (ParsedTransaction & { _sousCategorie: string })[]
): void {
  const groups = new Map<string, (ParsedTransaction & { _sousCategorie: string })[]>();
  for (const row of rows) {
    if (!row._sousCategorie) continue;
    const key = `${row.date}|${row._sousCategorie}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const [a, b] = group;
    if (a.amount !== 0 && Math.abs(a.amount + b.amount) < 0.01) {
      a.isExcluded = true;
      b.isExcluded = true;
    }
  }
}
