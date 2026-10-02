import crypto from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";

// Single-user login. The password lives in .env (APP_PASSWORD), never in the
// database. A successful login creates a random session token: the browser
// only ever holds the raw token in an HttpOnly cookie, the database only
// holds its SHA-256, so a leaked data.sqlite can't be replayed as a session.

const COOKIE_NAME = "lifeos_session";
const SESSION_DAYS = 180;

// Login brute-force guard, in memory (single process, reset on restart is fine).
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

// Routes the Android launcher widgets call (see own_launcher LifeOsHelper.kt).
// The launcher authenticates with a separate token (LAUNCHER_TOKEN) that can
// only reach these, so a token pulled off the phone can't read bank data or
// the chat.
const LAUNCHER_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: "GET", pattern: /^\/budget\/summary$/ },
  { method: "GET", pattern: /^\/goals$/ },
  { method: "POST", pattern: /^\/goals\/\d+\/checkins$/ },
  { method: "DELETE", pattern: /^\/goals\/\d+\/checkins\/\d{4}-\d{2}-\d{2}$/ },
  { method: "GET", pattern: /^\/todos$/ },
  { method: "POST", pattern: /^\/todos$/ },
  { method: "POST", pattern: /^\/todos\/\d+\/toggle$/ },
  { method: "DELETE", pattern: /^\/todos\/\d+$/ },
  { method: "POST", pattern: /^\/phone\/screen-time$/ },
];

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

// Hashing both sides first gives equal-length buffers, which
// timingSafeEqual requires, whatever the input lengths.
function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));
}

function clientIp(req: Request): string {
  // The backend only listens on 127.0.0.1 behind nginx, which sets X-Real-IP.
  return req.header("x-real-ip") || req.socket.remoteAddress || "unknown";
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.header("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function hasValidSession(req: Request): boolean {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  const row = db
    .prepare("SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > datetime('now')")
    .get(sha256(token));
  return Boolean(row);
}

function hasLauncherAccess(req: Request): boolean {
  const launcherToken = process.env.LAUNCHER_TOKEN;
  const auth = req.header("authorization");
  if (!launcherToken || !auth?.startsWith("Bearer ")) return false;
  if (!safeEqual(auth.slice("Bearer ".length), launcherToken)) return false;
  // req.path is relative to the /api mount point here.
  return LAUNCHER_ROUTES.some((r) => r.method === req.method && r.pattern.test(req.path));
}

// The host crontab hits this one route unattended to pull in new bank
// transactions without anyone ever opening the app. A dedicated secret
// (not LAUNCHER_TOKEN — that one's deliberately kept away from bank data,
// see above) scoped to just this route, so a leaked cron secret still
// can't reach anything else.
function hasCronAccess(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.header("authorization");
  if (!cronSecret || !auth?.startsWith("Bearer ")) return false;
  if (!safeEqual(auth.slice("Bearer ".length), cronSecret)) return false;
  return req.method === "POST" && req.path === "/banksync/import-all";
}

export const authRouter = express.Router();

authRouter.post("/login", (req, res) => {
  const password = process.env.APP_PASSWORD;
  if (!password) {
    return res.status(503).json({ error: "APP_PASSWORD n'est pas configuré sur le serveur." });
  }

  const ip = clientIp(req);
  const now = Date.now();
  const entry = attempts.get(ip);
  if (entry && now - entry.firstAt < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Trop de tentatives, réessaie dans 15 minutes." });
  }

  // Phone keyboards happily append a space after an autocompleted word, and
  // may send a different Unicode form of the same characters.
  const given = typeof req.body?.password === "string" ? req.body.password.trim().normalize("NFC") : "";
  if (!safeEqual(given, password.trim().normalize("NFC"))) {
    // Lengths only, never the value: enough to spot autocorrect/autofill.
    console.warn(`Login refusé : ${given.length} caractères reçus, ${password.trim().length} attendus.`);
    if (!entry || now - entry.firstAt >= WINDOW_MS) attempts.set(ip, { count: 1, firstAt: now });
    else entry.count++;
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }

  attempts.delete(ip);
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();

  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, expires_at) VALUES (?, datetime('now', ?))").run(
    sha256(token),
    `+${SESSION_DAYS} days`
  );

  // Lax, not Strict: the bank-sync callback is a top-level redirect back from
  // the bank's site, and it still needs the session cookie to be sent.
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

authRouter.post("/logout", (req, res) => {
  const token = readCookie(req, COOKIE_NAME);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

authRouter.get("/me", (req, res) => {
  res.json({ authenticated: hasValidSession(req) });
});

// Mounted on /api after the public routes (health, auth): everything below
// it needs a session cookie, or the launcher token for its few routes.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (hasValidSession(req) || hasLauncherAccess(req) || hasCronAccess(req)) return next();
  res.status(401).json({ error: "Non connecté." });
}
