import { Router } from "express";
import webpush from "web-push";
import { db } from "./db.js";
import { getState, setState } from "./state.js";

// Web Push to the installed PWA. The VAPID key pair is generated on first
// start and kept in app_state, so there's nothing to configure. Each phone
// or browser that enables notifications stores one subscription.

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function vapidKeys(): { publicKey: string; privateKey: string } {
  const stored = getState("vapid_keys");
  if (stored) return JSON.parse(stored);
  const keys = webpush.generateVAPIDKeys();
  setState("vapid_keys", JSON.stringify(keys));
  return keys;
}

const keys = vapidKeys();
webpush.setVapidDetails(process.env.PUBLIC_URL || "https://localhost", keys.publicKey, keys.privateKey);

export interface PushPayload {
  title: string;
  body: string;
  // Where tapping the notification opens the app.
  url?: string;
  // Same tag replaces an earlier notification instead of stacking.
  tag?: string;
}

// Sends to every subscribed device; subscriptions the push service reports
// as gone (404/410) are removed. Returns how many devices got it.
export async function sendPush(payload: PushPayload): Promise<number> {
  const subs = db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as {
    endpoint: string;
    p256dh: string;
    auth: string;
  }[];
  let delivered = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 6 * 3600 }
      );
      delivered++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(sub.endpoint);
      } else {
        console.error("Push :", status, (err as Error).message);
      }
    }
  }
  return delivered;
}

export const pushRouter = Router();

pushRouter.get("/key", (_req, res) => {
  res.json({ publicKey: keys.publicKey });
});

pushRouter.post("/subscribe", (req, res) => {
  const { endpoint, keys: subKeys } = req.body ?? {};
  if (typeof endpoint !== "string" || !subKeys?.p256dh || !subKeys?.auth) {
    return res.status(400).json({ error: "Abonnement invalide." });
  }
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(endpoint, subKeys.p256dh, subKeys.auth);
  res.json({ ok: true });
});

pushRouter.post("/unsubscribe", (req, res) => {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(String(req.body?.endpoint ?? ""));
  res.json({ ok: true });
});

pushRouter.post("/test", async (_req, res) => {
  const delivered = await sendPush({
    title: "Life OS",
    body: "Les notifications marchent. Tes rappels arriveront ici.",
    url: "/",
    tag: "test",
  });
  res.json({ delivered });
});
