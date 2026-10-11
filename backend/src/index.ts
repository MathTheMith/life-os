import "dotenv/config";
import express from "express";
import { chatRouter } from "./routes/chat.js";
import { transactionsRouter } from "./routes/transactions.js";
import { budgetRouter } from "./routes/budget.js";
import { envelopeRouter } from "./routes/envelope.js";
import { goalsRouter } from "./routes/goals.js";
import { racesRouter } from "./routes/races.js";
import { bankSyncRouter } from "./routes/bankSync.js";
import { todosRouter } from "./routes/todos.js";
import { conversationsRouter } from "./routes/conversations.js";
import { profileRouter } from "./routes/profile.js";
import { journalRouter } from "./routes/journal.js";
import { watchRouter } from "./routes/watch.js";
import { startWatchScheduler } from "./watch.js";
import { agendaRouter } from "./routes/agenda.js";
import { phoneRouter } from "./routes/phone.js";
import { mailRouter } from "./routes/mail.js";
import { startMailScheduler } from "./mail.js";
import { pushRouter } from "./push.js";
import { startReminderScheduler } from "./reminders.js";
import { briefRouter, startDailyScheduler } from "./brief.js";
import { actionsRouter } from "./routes/actions.js";
import { coachRouter } from "./coach.js";
import { simLapsRouter } from "./routes/simLaps.js";
import { uploadsDir } from "./db.js";
import { authRouter, requireAuth } from "./auth.js";
import { startAgendaTodoSyncScheduler } from "./agendaTodoSync.js";
import { systemRouter } from "./routes/system.js";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 3001;

// Default 100kb is fine for everything except chat images, sent inline as a
// base64 data: URI in the JSON body (the frontend already downsizes them
// before sending, this is just headroom, not the primary size control).
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);

// Everything registered after this line needs a login (see auth.ts).
app.use("/api", requireAuth);

// Images attached to chat messages, served back for display in the app.
app.use("/api/uploads", express.static(uploadsDir));
app.use("/api/chat", chatRouter);
app.use("/api/system", systemRouter);
app.use("/api/transactions", transactionsRouter);
app.use("/api/budget", budgetRouter);
app.use("/api/envelope", envelopeRouter);
app.use("/api/goals", goalsRouter);
app.use("/api/races", racesRouter);
app.use("/api/banksync", bankSyncRouter);
app.use("/api/todos", todosRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/journal", journalRouter);
app.use("/api/watch", watchRouter);
app.use("/api/agenda", agendaRouter);
app.use("/api/phone", phoneRouter);
app.use("/api/mail", mailRouter);
app.use("/api/push", pushRouter);
app.use("/api/brief", briefRouter);
app.use("/api/actions", actionsRouter);
app.use("/api/coach", coachRouter);
app.use("/api/sim-laps", simLapsRouter);

app.listen(port, () => {
  console.log(`life-os backend listening on http://localhost:${port}`);
  startWatchScheduler();
  startMailScheduler();
  startReminderScheduler();
  startDailyScheduler();
  startAgendaTodoSyncScheduler();
});
