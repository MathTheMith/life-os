import { Router } from "express";
import { db } from "../db.js";
import { listMails, runMail, isMailRunning, mailAccounts } from "../mail.js";
import { getState } from "../state.js";

export const mailRouter = Router();

mailRouter.get("/", (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 365);
  res.json(listMails(days));
});

mailRouter.get("/status", (_req, res) => {
  res.json({
    running: isMailRunning(),
    lastRun: getState("mail_last_run") ?? null,
    accounts: mailAccounts().map((a) => ({ address: a.user, error: getState(`mail_error:${a.user}`) || null })),
  });
});

mailRouter.post("/run", (_req, res) => {
  if (!isMailRunning()) runMail().catch((err) => console.error("Mails :", err));
  res.json({ running: true });
});

// For the launcher's radar/mail indicator widget: how many triaged mails
// are sitting there, scored important, that he hasn't swiped on yet.
mailRouter.get("/summary", (_req, res) => {
  const { importantCount } = db
    .prepare("SELECT COUNT(*) AS importantCount FROM mail_messages WHERE ai_status = 'done' AND user_rating IS NULL AND importance >= 50")
    .get() as { importantCount: number };
  res.json({ importantCount });
});

// The user's swipe: "important", "not", or null to undo.
mailRouter.post("/:id/rate", (req, res) => {
  const rating = req.body?.rating ?? null;
  if (rating !== null && rating !== "important" && rating !== "not") {
    return res.status(400).json({ error: "Note invalide." });
  }
  db.prepare("UPDATE mail_messages SET user_rating = ? WHERE id = ?").run(rating, req.params.id);
  res.json({ ok: true });
});
