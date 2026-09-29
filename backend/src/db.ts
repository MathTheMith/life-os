import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.DATA_DIR || path.join(__dirname, "..");
fs.mkdirSync(dataDir, { recursive: true });
export const uploadsDir = path.join(dataDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });
const dbPath = path.join(dataDir, "data.sqlite");

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    label TEXT NOT NULL,
    amount REAL NOT NULL,
    category TEXT NOT NULL DEFAULT 'autre',
    import_batch TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_excluded INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS budgets (
    category TEXT PRIMARY KEY,
    monthly_limit REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS category_rules (
    keyword TEXT PRIMARY KEY,
    category TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS envelopes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    total_amount REAL NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    kind TEXT NOT NULL DEFAULT 'unique',
    target_date TEXT,
    status TEXT NOT NULL DEFAULT 'a_faire',
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goal_checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS race_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    event TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'karting',
    quali_position INTEGER,
    quali_chrono REAL,
    course_chrono REAL,
    position_finale INTEGER,
    chrono_vainqueur REAL,
    ecart_leader REAL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bank_connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    aspsp_name TEXT NOT NULL,
    aspsp_country TEXT NOT NULL,
    valid_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS bank_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    iban TEXT,
    name TEXT,
    last_synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL DEFAULT 'Nouvelle conversation',
    memory TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversation_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assistant_memory (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS assistant_notes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL DEFAULT ''
  );
`);

// Singleton row — global memory shared across every conversation.
const hasMemoryRow = db.prepare("SELECT id FROM assistant_memory WHERE id = 1").get();
if (!hasMemoryRow) {
  db.prepare("INSERT INTO assistant_memory (id, content) VALUES (1, '')").run();
}

// Singleton row — the assistant's own notes, written by it without asking.
const hasNotesRow = db.prepare("SELECT id FROM assistant_notes WHERE id = 1").get();
if (!hasNotesRow) {
  db.prepare("INSERT INTO assistant_notes (id, content) VALUES (1, '')").run();
}

const envelopeCount = (db.prepare("SELECT COUNT(*) as n FROM envelopes").get() as { n: number }).n;
if (envelopeCount === 0) {
  const start = new Date();
  const end = new Date(start);
  end.setMonth(end.getMonth() + 12);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  db.prepare(
    "INSERT INTO envelopes (name, category, total_amount, period_start, period_end) VALUES (?, ?, ?, ?, ?)"
  ).run("Motorsport", "motorsport", 5000, iso(start), iso(end));
}

// Safe to run on every startup: ALTER TABLE ADD COLUMN fails if the column
// already exists, so only add it the first time an existing (pre-migration)
// database is opened. Fresh databases already have it from CREATE TABLE above.
const hasIsExcluded = (db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[]).some(
  (col) => col.name === "is_excluded"
);
if (!hasIsExcluded) {
  db.exec("ALTER TABLE transactions ADD COLUMN is_excluded INTEGER NOT NULL DEFAULT 0");
}

const hasExternalId = (db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[]).some(
  (col) => col.name === "external_id"
);
if (!hasExternalId) {
  db.exec("ALTER TABLE transactions ADD COLUMN external_id TEXT");
}
// Partial unique index: only enforced when external_id is set, so CSV/manual
// rows (external_id NULL) are unaffected. Lets bank-sync imports use
// INSERT OR IGNORE to dedupe re-fetched transactions for free.
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_external_id ON transactions(external_id) WHERE external_id IS NOT NULL"
);

const hasImagePath = (db.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[]).some(
  (col) => col.name === "image_path"
);
if (!hasImagePath) {
  db.exec("ALTER TABLE conversation_messages ADD COLUMN image_path TEXT");
}

// The image itself is kept only for display (image_path, served back as-is
// to the app); image_description is what the model actually sees on every
// future turn — see imageDescribe.ts for why.
const hasImageDescription = (
  db.prepare("PRAGMA table_info(conversation_messages)").all() as { name: string }[]
).some((col) => col.name === "image_description");
if (!hasImageDescription) {
  db.exec("ALTER TABLE conversation_messages ADD COLUMN image_description TEXT");
}

const defaultRules: Record<string, string> = {
  carrefour: "alimentation",
  leclerc: "alimentation",
  monoprix: "alimentation",
  lidl: "alimentation",
  restaurant: "alimentation",
  uber: "transport",
  sncf: "transport",
  essence: "transport",
  total: "transport",
  "park events": "motorsport",
  kart: "motorsport",
  laquais: "motorsport",
  ldlc: "motorsport",
  "planete karting": "motorsport",
  "green kart": "motorsport",
  netflix: "abonnements",
  spotify: "abonnements",
  anthropic: "abonnements",
  amazon: "loisirs",
  loyer: "logement",
  edf: "logement",
  engie: "logement",
  salaire: "revenus",
  "depot espece": "revenus",
  auchan: "alimentation",
  cafeomatic: "alimentation",
  maxicoffee: "alimentation",
  vinted: "shopping",
};

// ldlc used to seed as "loisirs" before motorsport-specific tracking existed
// (it's the sim racing contest entry fee) — INSERT OR IGNORE won't touch an
// already-seeded row, so fix it explicitly for databases created before this.
db.prepare("UPDATE category_rules SET category = 'motorsport' WHERE keyword = 'ldlc' AND category = 'loisirs'").run();

const insertRule = db.prepare(
  "INSERT OR IGNORE INTO category_rules (keyword, category) VALUES (?, ?)"
);
const seedRules = db.transaction((rules: Record<string, string>) => {
  for (const [keyword, category] of Object.entries(rules)) {
    insertRule.run(keyword, category);
  }
});
seedRules(defaultRules);
