import { Router } from "express";
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
