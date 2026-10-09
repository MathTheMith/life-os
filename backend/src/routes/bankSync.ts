import { Router } from "express";
import { db } from "../db.js";
import { categorizeWithFallback } from "../categorize.js";
import { categorizeBatchWithAI } from "../aiCategorize.js";
import { listAspsps, startAuth, exchangeSession, fetchTransactions, newState } from "../enablebanking/client.js";
import { mapTransaction } from "../enablebanking/mapping.js";

export const bankSyncRouter = Router();

function publicUrl(): string {
  const url = process.env.PUBLIC_URL;
  if (!url) throw new Error("PUBLIC_URL manquant dans l'environnement.");
  return url.replace(/\/$/, "");
}

// Short-lived (auth flow completes in minutes) so an in-memory map is enough —
// no need to survive a backend restart mid-flow.
const pendingAuth = new Map<string, { aspspName: string; aspspCountry: string; createdAt: number }>();
const PENDING_TTL_MS = 15 * 60 * 1000;

function cleanupPending() {
  const now = Date.now();
  for (const [state, entry] of pendingAuth) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingAuth.delete(state);
  }
}

bankSyncRouter.get("/aspsps", async (req, res) => {
  const country = (req.query.country as string) || "FR";
  try {
    const aspsps = await listAspsps(country);
    res.json(aspsps.map((a) => ({ name: a.name, country: a.country, logo: a.logo, bic: a.bic })));
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

bankSyncRouter.post("/connect", async (req, res) => {
  const { aspspName, aspspCountry } = req.body as { aspspName?: string; aspspCountry?: string };
  if (!aspspName || !aspspCountry) {
    return res.status(400).json({ error: "aspspName et aspspCountry requis." });
  }
  cleanupPending();
  const state = newState();
  pendingAuth.set(state, { aspspName, aspspCountry, createdAt: Date.now() });
  try {
    const { url } = await startAuth({
      aspspName,
      aspspCountry,
      redirectUrl: `${publicUrl()}/api/banksync/callback`,
      state,
      validDays: 90,
    });
    res.json({ url });
  } catch (err) {
    pendingAuth.delete(state);
    res.status(502).json({ error: (err as Error).message });
  }
});

bankSyncRouter.get("/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state || !pendingAuth.has(state)) {
    return res.redirect(`${publicUrl()}/?bank=error`);
  }
  pendingAuth.delete(state);
  try {
    const session = await exchangeSession(code);

    // A consent (default 90 days here) expires and must be renewed by going
    // through "Connecter ma banque" again. Reusing the existing connection
    // row (matched on aspsp) instead of inserting a new one avoids piling up
    // duplicate entries in the Import tab on every renewal, and preserving
    // known accounts' last_synced_at keeps sync incremental across renewals.
    const existingConnection = db
      .prepare("SELECT id FROM bank_connections WHERE aspsp_name = ? AND aspsp_country = ?")
      .get(session.aspsp.name, session.aspsp.country) as { id: number } | undefined;

    const upsertAll = db.transaction(() => {
      let connectionId: number;
      if (existingConnection) {
        connectionId = existingConnection.id;
        db.prepare("UPDATE bank_connections SET session_id = ?, valid_until = ? WHERE id = ?").run(
          session.sessionId,
          session.validUntil ?? null,
          connectionId
        );
      } else {
        const result = db
          .prepare("INSERT INTO bank_connections (session_id, aspsp_name, aspsp_country, valid_until) VALUES (?, ?, ?, ?)")
          .run(session.sessionId, session.aspsp.name, session.aspsp.country, session.validUntil ?? null);
        connectionId = Number(result.lastInsertRowid);
      }

      const existingAccounts = db
        .prepare("SELECT id, iban FROM bank_accounts WHERE connection_id = ?")
        .all(connectionId) as { id: number; iban: string | null }[];

      for (const account of session.accounts) {
        const iban = account.account_id?.iban ?? null;
        const match = iban ? existingAccounts.find((a) => a.iban === iban) : undefined;
        if (match) {
          db.prepare("UPDATE bank_accounts SET uid = ?, name = ? WHERE id = ?").run(account.uid, account.name ?? null, match.id);
        } else {
          db.prepare("INSERT INTO bank_accounts (connection_id, uid, iban, name) VALUES (?, ?, ?, ?)").run(
            connectionId,
            account.uid,
            iban,
            account.name ?? null
          );
        }
      }
    });
    upsertAll();
    res.redirect(`${publicUrl()}/?bank=connected`);
  } catch (err) {
    console.error("Enable Banking callback error:", err);
    res.redirect(`${publicUrl()}/?bank=error`);
  }
});

bankSyncRouter.get("/connections", (_req, res) => {
  const connections = db.prepare("SELECT * FROM bank_connections ORDER BY created_at DESC").all() as {
    id: number;
    aspsp_name: string;
    aspsp_country: string;
    valid_until: string | null;
    created_at: string;
  }[];
  const accountsStmt = db.prepare("SELECT id, uid, iban, name, last_synced_at FROM bank_accounts WHERE connection_id = ?");
  const withAccounts = connections.map((c) => ({ ...c, accounts: accountsStmt.all(c.id) }));
  res.json(withAccounts);
});

bankSyncRouter.delete("/connections/:id", (req, res) => {
  db.prepare("DELETE FROM bank_connections WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

async function importConnection(connectionId: number): Promise<number> {
  const connection = db.prepare("SELECT * FROM bank_connections WHERE id = ?").get(connectionId) as
    | { id: number; created_at: string }
    | undefined;
  if (!connection) throw new Error("Connexion introuvable.");

  const accounts = db.prepare("SELECT * FROM bank_accounts WHERE connection_id = ?").all(connection.id) as {
    id: number;
    uid: string;
    iban: string | null;
    last_synced_at: string | null;
  }[];

  // Own IBANs across every connected bank (not just this one) so a transfer
  // between two of the user's own accounts at different banks is still
  // recognized and excluded, the same way the CSV import excludes internal
  // transfers flagged by the bank itself.
  const ownIbans = new Set(
    (db.prepare("SELECT iban FROM bank_accounts WHERE iban IS NOT NULL").all() as { iban: string }[]).map(
      (r) => r.iban
    )
  );

  const insert = db.prepare(
    "INSERT OR IGNORE INTO transactions (date, label, amount, category, import_batch, is_excluded, external_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const updateSync = db.prepare("UPDATE bank_accounts SET last_synced_at = ? WHERE id = ?");

  const today = new Date().toISOString().slice(0, 10);
  let imported = 0;

  for (const account of accounts) {
    // Banks often post a transaction a few days late but dated when it
    // happened (a card payment on the 7th showing up on the 9th, dated the
    // 7th). Starting exactly at the last sync day would skip those for good,
    // so every run re-reads a 10-day overlap; already-imported rows are
    // ignored thanks to the unique index on external_id.
    const since = new Date(`${(account.last_synced_at || connection.created_at).slice(0, 10)}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 10);
    const dateFrom = since.toISOString().slice(0, 10);
    const rawTransactions = await fetchTransactions(account.uid, { dateFrom, dateTo: today });
    const mapped = rawTransactions.map((tx) => mapTransaction(tx, ownIbans)).filter((m) => m !== null);

    // Keyword rules first (instant, free); whatever they can't place goes
    // through the AI in one batched call before the (synchronous, per
    // better-sqlite3) insert transaction — never awaited from inside it.
    const withCategory = mapped.map((tx) => ({ tx, category: categorizeWithFallback(tx.label, tx.bankCategory) }));
    const uncertain = withCategory.filter((r) => r.category === "autre");
    if (uncertain.length > 0) {
      const aiCategories = await categorizeBatchWithAI(
        uncertain.map((r) => ({ label: r.tx.label, amount: r.tx.amount, bankCategory: r.tx.bankCategory }))
      );
      uncertain.forEach((r, i) => {
        if (aiCategories[i]) r.category = aiCategories[i]!;
      });
    }

    const insertMany = db.transaction(() => {
      for (const { tx, category } of withCategory) {
        const result = insert.run(
          tx.date,
          tx.label,
          tx.amount,
          category,
          `enablebanking:${connection.id}`,
          tx.isExcluded ? 1 : 0,
          tx.externalId
        );
        if (result.changes > 0) imported += 1;
      }
      updateSync.run(today, account.id);
    });
    insertMany();
  }
  return imported;
}

bankSyncRouter.post("/connections/:id/import", async (req, res) => {
  try {
    const imported = await importConnection(Number(req.params.id));
    res.json({ imported });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

// Hit daily by a host crontab entry so new transactions land without opening
// the app. Imports every connection independently so one failing/expired
// consent doesn't block the others; per-connection errors are reported back
// but don't throw, since this runs unattended.
bankSyncRouter.post("/import-all", async (_req, res) => {
  const connections = db.prepare("SELECT id, aspsp_name FROM bank_connections").all() as {
    id: number;
    aspsp_name: string;
  }[];

  const results = [];
  for (const connection of connections) {
    try {
      const imported = await importConnection(connection.id);
      results.push({ connectionId: connection.id, aspsp: connection.aspsp_name, imported });
    } catch (err) {
      results.push({ connectionId: connection.id, aspsp: connection.aspsp_name, error: (err as Error).message });
    }
  }
  res.json({ results });
});
