import { Router } from "express";
import { db } from "../db.js";

export const envelopeRouter = Router();

interface Envelope {
  id: number;
  name: string;
  category: string;
  total_amount: number;
  period_start: string;
  period_end: string;
}

function summarize(envelope: Envelope) {
  const spentRow = db
    .prepare(
      `SELECT SUM(amount) as total FROM transactions
       WHERE category = ? AND amount < 0 AND is_excluded = 0 AND date >= ? AND date <= ?`
    )
    .get(envelope.category, envelope.period_start, envelope.period_end) as { total: number | null };

  const spent = Math.abs(spentRow.total ?? 0);
  const remaining = envelope.total_amount - spent;

  const start = new Date(envelope.period_start);
  const end = new Date(envelope.period_end);
  const now = new Date();
  const totalDays = Math.max(1, (end.getTime() - start.getTime()) / 86_400_000);
  const elapsedDays = Math.min(totalDays, Math.max(0, (now.getTime() - start.getTime()) / 86_400_000));
  const remainingDays = Math.max(0, totalDays - elapsedDays);

  const dailyBurnRate = elapsedDays > 0 ? spent / elapsedDays : 0;
  const projectedTotal = spent + dailyBurnRate * remainingDays;

  return {
    ...envelope,
    spent: Math.round(spent * 100) / 100,
    remaining: Math.round(remaining * 100) / 100,
    percentUsed: envelope.total_amount > 0 ? Math.min(999, (spent / envelope.total_amount) * 100) : 0,
    daysRemaining: Math.round(remainingDays),
    projectedTotal: Math.round(projectedTotal * 100) / 100,
    onTrack: projectedTotal <= envelope.total_amount,
  };
}

export function listEnvelopesWithSummary() {
  const envelopes = db.prepare("SELECT * FROM envelopes ORDER BY id ASC").all() as Envelope[];
  return envelopes.map(summarize);
}

envelopeRouter.get("/", (_req, res) => {
  res.json(listEnvelopesWithSummary());
});

envelopeRouter.patch("/:id", (req, res) => {
  const { totalAmount, periodStart, periodEnd } = req.body as {
    totalAmount?: number;
    periodStart?: string;
    periodEnd?: string;
  };

  const envelope = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(req.params.id) as
    | Envelope
    | undefined;
  if (!envelope) return res.status(404).json({ error: "Enveloppe introuvable" });

  db.prepare(
    `UPDATE envelopes SET
       total_amount = COALESCE(?, total_amount),
       period_start = COALESCE(?, period_start),
       period_end = COALESCE(?, period_end)
     WHERE id = ?`
  ).run(totalAmount ?? null, periodStart ?? null, periodEnd ?? null, req.params.id);

  const updated = db.prepare("SELECT * FROM envelopes WHERE id = ?").get(req.params.id) as Envelope;
  res.json(summarize(updated));
});
