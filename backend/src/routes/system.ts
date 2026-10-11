import { Router } from "express";
import { db } from "../db.js";
import { getState } from "../state.js";
import { mailAccounts } from "../mail.js";

export const systemRouter = Router();

// A scheduled job that fails silently (console.error, nothing else) used to
// mean the brief/veille/mail triage could just stop one day and nobody
// would notice until something downstream looked obviously wrong. This
// exposes each job's last known success so the app can flag it instead.

interface JobHealth {
  lastAt: string | null;
  stale: boolean;
}

function jobHealth(lastAt: string | null | undefined, maxAgeHours: number): JobHealth {
  if (!lastAt) return { lastAt: null, stale: true };
  const ageHours = (Date.now() - Date.parse(lastAt)) / 3_600_000;
  return { lastAt, stale: ageHours > maxAgeHours };
}

systemRouter.get("/health", (_req, res) => {
  const lastBrief = db.prepare("SELECT created_at FROM briefs ORDER BY date DESC LIMIT 1").get() as { created_at: string } | undefined;

  const hasMailAccounts = mailAccounts().length > 0;
  const mailErrors = hasMailAccounts
    ? mailAccounts()
        .map((a) => ({ account: a.user, message: getState(`mail_error:${a.user}`) }))
        .filter((e) => e.message)
    : [];

  res.json({
    // Expected once a day, in the morning — generous threshold so a
    // slightly-late run isn't flagged as broken.
    brief: jobHealth(lastBrief?.created_at, 30),
    // Runs at 7h and 18h Paris time — 15h covers a single missed slot
    // without flagging on every ordinary gap between the two.
    watch: jobHealth(getState("watch_last_run"), 15),
    // Checked every 30 min when accounts are configured; irrelevant (never
    // "stale") when there are none.
    mail: hasMailAccounts ? jobHealth(getState("mail_last_run"), 3) : { lastAt: null, stale: false },
    mailErrors,
  });
});
