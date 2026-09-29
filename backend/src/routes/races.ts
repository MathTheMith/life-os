import { Router } from "express";
import { db } from "../db.js";

export const racesRouter = Router();

racesRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT * FROM race_logs ORDER BY date DESC, id DESC").all();
  res.json(rows);
});

racesRouter.post("/", (req, res) => {
  const {
    date,
    event,
    type,
    qualiPosition,
    qualiChrono,
    courseChrono,
    positionFinale,
    chronoVainqueur,
    ecartLeader,
    notes,
  } = req.body as {
    date?: string;
    event?: string;
    type?: string;
    qualiPosition?: number;
    qualiChrono?: number;
    courseChrono?: number;
    positionFinale?: number;
    chronoVainqueur?: number;
    ecartLeader?: number;
    notes?: string;
  };

  if (!date || !event) {
    return res.status(400).json({ error: "date et event requis" });
  }

  const result = db
    .prepare(
      `INSERT INTO race_logs
        (date, event, type, quali_position, quali_chrono, course_chrono, position_finale, chrono_vainqueur, ecart_leader, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      date,
      event,
      type || "karting",
      qualiPosition ?? null,
      qualiChrono ?? null,
      courseChrono ?? null,
      positionFinale ?? null,
      chronoVainqueur ?? null,
      ecartLeader ?? null,
      notes || null
    );

  res.json({ id: result.lastInsertRowid });
});

racesRouter.patch("/:id", (req, res) => {
  const {
    date,
    event,
    type,
    qualiPosition,
    qualiChrono,
    courseChrono,
    positionFinale,
    chronoVainqueur,
    ecartLeader,
    notes,
  } = req.body as {
    date?: string;
    event?: string;
    type?: string;
    qualiPosition?: number | null;
    qualiChrono?: number | null;
    courseChrono?: number | null;
    positionFinale?: number | null;
    chronoVainqueur?: number | null;
    ecartLeader?: number | null;
    notes?: string | null;
  };

  const existing = db.prepare("SELECT id FROM race_logs WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Course introuvable" });

  db.prepare(
    `UPDATE race_logs SET
       date = COALESCE(?, date),
       event = COALESCE(?, event),
       type = COALESCE(?, type),
       quali_position = ?,
       quali_chrono = ?,
       course_chrono = ?,
       position_finale = ?,
       chrono_vainqueur = ?,
       ecart_leader = ?,
       notes = ?
     WHERE id = ?`
  ).run(
    date ?? null,
    event ?? null,
    type ?? null,
    qualiPosition ?? null,
    qualiChrono ?? null,
    courseChrono ?? null,
    positionFinale ?? null,
    chronoVainqueur ?? null,
    ecartLeader ?? null,
    notes ?? null,
    req.params.id
  );

  res.json({ ok: true });
});

racesRouter.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM race_logs WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
