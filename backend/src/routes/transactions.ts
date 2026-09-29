import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { parseBankCsv, decodeCsvBuffer } from "../csv.js";
import { categorizeWithFallback, extractKeyword } from "../categorize.js";
import { categorizeBatchWithAI } from "../aiCategorize.js";

const upload = multer({ storage: multer.memoryStorage() });
export const transactionsRouter = Router();

transactionsRouter.post("/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Aucun fichier reçu (champ 'file' attendu)." });
  }

  let parsed;
  try {
    parsed = parseBankCsv(decodeCsvBuffer(req.file.buffer));
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message });
  }

  const withCategory = parsed.map((row) => ({ row, category: categorizeWithFallback(row.label, row.bankCategory) }));
  const uncertain = withCategory.filter((r) => r.category === "autre");
  if (uncertain.length > 0) {
    const aiCategories = await categorizeBatchWithAI(
      uncertain.map((r) => ({ label: r.row.label, amount: r.row.amount, bankCategory: r.row.bankCategory }))
    );
    uncertain.forEach((r, i) => {
      if (aiCategories[i]) r.category = aiCategories[i]!;
    });
  }

  const batchId = randomUUID();
  const insert = db.prepare(
    "INSERT INTO transactions (date, label, amount, category, import_batch, is_excluded) VALUES (?, ?, ?, ?, ?, ?)"
  );
  let excludedCount = 0;
  const insertMany = db.transaction((rows: typeof withCategory) => {
    for (const { row, category } of rows) {
      if (row.isExcluded) excludedCount += 1;
      insert.run(row.date, row.label, row.amount, category, batchId, row.isExcluded ? 1 : 0);
    }
  });
  insertMany(withCategory);

  res.json({ imported: parsed.length, batchId, excluded: excludedCount });
});

transactionsRouter.post("/", async (req, res) => {
  const { date, label, amount, category, excluded } = req.body as {
    date?: string;
    label?: string;
    amount?: number;
    category?: string;
    excluded?: boolean;
  };

  if (!date || !label || typeof amount !== "number") {
    return res
      .status(400)
      .json({ error: "date (YYYY-MM-DD), label et amount (number) requis." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: "date doit être au format YYYY-MM-DD." });
  }

  let finalCategory = category || categorizeWithFallback(label);
  if (!category && finalCategory === "autre") {
    const [aiCategory] = await categorizeBatchWithAI([{ label, amount }]);
    if (aiCategory) finalCategory = aiCategory;
  }
  const result = db
    .prepare(
      "INSERT INTO transactions (date, label, amount, category, import_batch, is_excluded) VALUES (?, ?, ?, ?, 'manuel', ?)"
    )
    .run(date, label, amount, finalCategory, excluded ? 1 : 0);

  res.json({ id: result.lastInsertRowid, category: finalCategory });
});

transactionsRouter.get("/", (req, res) => {
  const month = req.query.month as string | undefined; // format YYYY-MM
  const category = req.query.category as string | undefined;
  const limitParam = req.query.limit ? Number(req.query.limit) : undefined;

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (month) {
    conditions.push("date LIKE ?");
    params.push(`${month}%`);
  }
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  // An explicit ?limit= always wins (e.g. the dashboard's "last 20"); an
  // unfiltered query otherwise defaults to 200 so it never returns the
  // entire history at once.
  const limit = limitParam ?? (month || category ? undefined : 200);
  if (limit) params.push(limit);

  const rows = db
    .prepare(`SELECT * FROM transactions ${where} ORDER BY date DESC, id DESC ${limit ? "LIMIT ?" : ""}`)
    .all(...params);

  res.json(rows);
});

transactionsRouter.patch("/:id/category", (req, res) => {
  const { category } = req.body as { category?: string };
  if (!category) return res.status(400).json({ error: "category requis" });

  const tx = db.prepare("SELECT label FROM transactions WHERE id = ?").get(req.params.id) as
    | { label: string }
    | undefined;
  db.prepare("UPDATE transactions SET category = ? WHERE id = ?").run(category, req.params.id);

  // Learn from the correction: next time this merchant shows up, keyword
  // rules place it directly instead of falling through to "autre"/AI again.
  // INSERT OR IGNORE so an existing rule for that keyword (however it got
  // there) is never silently overwritten by one bad guess.
  let learnedKeyword: string | null = null;
  if (category !== "autre" && tx) {
    const keyword = extractKeyword(tx.label);
    if (keyword) {
      const result = db
        .prepare("INSERT OR IGNORE INTO category_rules (keyword, category) VALUES (?, ?)")
        .run(keyword, category);
      if (result.changes > 0) learnedKeyword = keyword;
    }
  }

  res.json({ ok: true, learnedKeyword });
});

transactionsRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM transactions WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
