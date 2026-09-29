import { Router } from "express";
import { db } from "../db.js";

export const budgetRouter = Router();

export function getBudgetSummary(month: string) {
  const spentByCategory = db
    .prepare(
      `SELECT category, SUM(amount) as total
       FROM transactions
       WHERE date LIKE ? AND amount < 0 AND is_excluded = 0
       GROUP BY category`
    )
    .all(`${month}%`) as { category: string; total: number }[];

  const budgets = db.prepare("SELECT category, monthly_limit FROM budgets").all() as {
    category: string;
    monthly_limit: number;
  }[];

  const budgetMap = new Map(budgets.map((b) => [b.category, b.monthly_limit]));
  const spentMap = new Map(spentByCategory.map((s) => [s.category, Math.abs(s.total)]));

  const categories = new Set([...budgetMap.keys(), ...spentMap.keys()]);
  const summary = [...categories].map((category) => ({
    category,
    spent: spentMap.get(category) ?? 0,
    limit: budgetMap.get(category) ?? null,
  }));

  const receivedByCategory = db
    .prepare(
      `SELECT category, SUM(amount) as total
       FROM transactions
       WHERE date LIKE ? AND amount > 0 AND is_excluded = 0
       GROUP BY category`
    )
    .all(`${month}%`) as { category: string; total: number }[];

  const incomeCategories = receivedByCategory.map((r) => ({
    category: r.category,
    spent: r.total,
    limit: null as number | null,
  }));

  const totalIncome = incomeCategories.reduce((sum, c) => sum + c.spent, 0);
  const totalSpent = summary.reduce((sum, c) => sum + c.spent, 0);

  return {
    month,
    categories: summary,
    incomeCategories,
    totalIncome,
    totalSpent,
    balance: totalIncome - totalSpent,
  };
}

budgetRouter.get("/summary", (req, res) => {
  const month = (req.query.month as string) || new Date().toISOString().slice(0, 7);
  res.json(getBudgetSummary(month));
});

budgetRouter.post("/", (req, res) => {
  const { category, monthlyLimit } = req.body as {
    category?: string;
    monthlyLimit?: number;
  };
  if (!category || typeof monthlyLimit !== "number") {
    return res.status(400).json({ error: "category (string) et monthlyLimit (number) requis" });
  }
  db.prepare(
    `INSERT INTO budgets (category, monthly_limit) VALUES (?, ?)
     ON CONFLICT(category) DO UPDATE SET monthly_limit = excluded.monthly_limit`
  ).run(category, monthlyLimit);
  res.json({ ok: true });
});

budgetRouter.get("/", (_req, res) => {
  res.json(db.prepare("SELECT category, monthly_limit FROM budgets").all());
});
