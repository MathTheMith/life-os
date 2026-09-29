import { db } from "./db.js";

/**
 * Builds a compact text summary of the user's current finances, motorsport
 * budget envelope, goals, and recent race results, so the chat assistant can
 * answer questions across all of it without a full tool-use round trip.
 * Regenerated on every chat request — always current.
 */
export function buildFinanceContext(): string {
  const month = new Date().toISOString().slice(0, 7);

  const spentByCategory = db
    .prepare(
      `SELECT category, SUM(amount) as total FROM transactions
       WHERE date LIKE ? AND amount < 0 AND is_excluded = 0 GROUP BY category ORDER BY total ASC`
    )
    .all(`${month}%`) as { category: string; total: number }[];

  const income = db
    .prepare(
      `SELECT SUM(amount) as total FROM transactions WHERE date LIKE ? AND amount > 0 AND is_excluded = 0`
    )
    .get(`${month}%`) as { total: number | null };

  const totalSpent = spentByCategory.reduce((sum, c) => sum + Math.abs(c.total), 0);
  const totalIncome = income.total ?? 0;

  // Excluded here too — a transfer to savings would otherwise show up as
  // "a 2400€ expense" in the assistant's recent-activity view, which is
  // exactly the confusion this flag exists to prevent.
  const recent = db
    .prepare(
      `SELECT date, label, amount, category FROM transactions WHERE is_excluded = 0 ORDER BY date DESC, id DESC LIMIT 15`
    )
    .all() as { date: string; label: string; amount: number; category: string }[];

  const categoryLines = spentByCategory
    .map((c) => `  - ${c.category} : ${Math.abs(c.total).toFixed(2)} €`)
    .join("\n") || "  (aucune dépense ce mois-ci)";

  const recentLines = recent
    .map((t) => `  - ${t.date} | ${t.amount.toFixed(2)} € | ${t.label} | ${t.category}`)
    .join("\n") || "  (aucune transaction)";

  const envelopes = db.prepare("SELECT * FROM envelopes").all() as {
    name: string;
    category: string;
    total_amount: number;
    period_start: string;
    period_end: string;
  }[];

  const envelopeLines = envelopes
    .map((e) => {
      const spentRow = db
        .prepare(
          `SELECT SUM(amount) as total FROM transactions
           WHERE category = ? AND amount < 0 AND is_excluded = 0 AND date >= ? AND date <= ?`
        )
        .get(e.category, e.period_start, e.period_end) as { total: number | null };
      const spent = Math.abs(spentRow.total ?? 0);
      return `  - ${e.name} : ${spent.toFixed(2)} € dépensés sur ${e.total_amount.toFixed(2)} € (période ${e.period_start} à ${e.period_end}), reste ${(e.total_amount - spent).toFixed(2)} €`;
    })
    .join("\n") || "  (aucune enveloppe définie)";

  const goals = db
    .prepare("SELECT title, kind, status, target_date FROM goals WHERE status != 'abandonne' ORDER BY target_date IS NULL, target_date ASC")
    .all() as { title: string; kind: string; status: string; target_date: string | null }[];

  const goalLines = goals
    .map((g) => {
      const date = g.target_date ? ` (échéance ${g.target_date})` : "";
      const kindLabel = g.kind === "recurrent" ? "récurrent" : "unique";
      return `  - [${g.status}] ${g.title}${date} — objectif ${kindLabel}`;
    })
    .join("\n") || "  (aucun objectif défini)";

  const races = db
    .prepare("SELECT * FROM race_logs ORDER BY date DESC LIMIT 5")
    .all() as {
    date: string;
    event: string;
    type: string;
    quali_position: number | null;
    position_finale: number | null;
    course_chrono: number | null;
    ecart_leader: number | null;
    notes: string | null;
  }[];

  const raceLines = races
    .map((r) => {
      const parts = [`${r.date} — ${r.event} (${r.type})`];
      if (r.quali_position != null) parts.push(`quali P${r.quali_position}`);
      if (r.position_finale != null) parts.push(`arrivée P${r.position_finale}`);
      if (r.course_chrono != null) parts.push(`chrono ${r.course_chrono}s`);
      if (r.ecart_leader != null) parts.push(`écart leader ${r.ecart_leader}s`);
      if (r.notes) parts.push(`notes: ${r.notes}`);
      return `  - ${parts.join(" | ")}`;
    })
    .join("\n") || "  (aucune course enregistrée)";

  return `Contexte actuel de l'utilisateur (mois ${month}) :

FINANCES
Revenus du mois : ${totalIncome.toFixed(2)} €
Dépenses du mois : ${totalSpent.toFixed(2)} €
Solde du mois : ${(totalIncome - totalSpent).toFixed(2)} €

Dépenses par catégorie ce mois-ci :
${categoryLines}

15 dernières transactions (toutes dates confondues) :
${recentLines}

ENVELOPPES BUDGET
${envelopeLines}

OBJECTIFS (motorsport, sport, autre)
${goalLines}

5 DERNIÈRES COURSES / SESSIONS ENREGISTRÉES
${raceLines}

Utilise ces données si l'utilisateur pose une question sur son budget, ses dépenses, ses objectifs ou ses performances en course. L'utilisateur vise à terme le sport automobile professionnel — relie les questions financières à cet objectif quand c'est pertinent (ex: son budget motorsport est-il tenable, est-ce qu'il progresse). Ne mentionne ces données que si la question a un rapport.`;
}
