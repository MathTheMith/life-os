import { Router } from "express";
import {
  listActions,
  acceptAction,
  completeAction,
  dismissAction,
  updateActionDraft,
  generateMorningActions,
} from "../actions.js";

export const actionsRouter = Router();

actionsRouter.get("/", (_req, res) => {
  res.json(listActions());
});

// "Oui": Gmail draft for a mail, agenda entry for an outing.
actionsRouter.post("/:id/accept", async (req, res) => {
  try {
    res.json(await acceptAction(Number(req.params.id)));
  } catch (err) {
    console.error("Action (oui) :", err);
    res.status(502).json({ error: (err as Error).message || "Impossible de créer le brouillon." });
  }
});

actionsRouter.post("/:id/done", (req, res) => {
  res.json(completeAction(Number(req.params.id)) ?? null);
});

actionsRouter.post("/:id/dismiss", (req, res) => {
  res.json(dismissAction(Number(req.params.id)) ?? null);
});

actionsRouter.put("/:id", (req, res) => {
  const { mail_to, mail_subject, mail_body } = req.body ?? {};
  res.json(updateActionDraft(Number(req.params.id), { mail_to, mail_subject, mail_body }) ?? null);
});

// Runs the morning preparation now (returns right away).
actionsRouter.post("/run", (_req, res) => {
  generateMorningActions().catch((err) => console.error("Actions :", err));
  res.json({ running: true });
});
