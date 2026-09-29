import { createSign, randomUUID } from "node:crypto";
import fs from "node:fs";

const API_BASE = "https://api.enablebanking.com";

function loadPrivateKey(): string {
  const path = process.env.ENABLEBANKING_PRIVATE_KEY_PATH;
  if (!path) throw new Error("ENABLEBANKING_PRIVATE_KEY_PATH manquant dans l'environnement.");
  return fs.readFileSync(path, "utf8");
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Enable Banking authenticates every API call with a JWT signed by our own
// RSA key (RS256), not an OAuth token — kid is the application_id issued
// after we upload the matching public certificate on their dashboard.
function signJwt(appId: string): string {
  const header = { typ: "JWT", alg: "RS256", kid: appId };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp: now + 3600 };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(loadPrivateKey());
  return `${signingInput}.${base64url(signature)}`;
}

function appId(): string {
  const id = process.env.ENABLEBANKING_APP_ID;
  if (!id) throw new Error("ENABLEBANKING_APP_ID manquant dans l'environnement.");
  return id;
}

async function ebFetch(path: string, options: { method?: string; body?: unknown } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${signJwt(appId())}`,
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429) {
      // PSD2 RTS on SCA caps unattended (no user present) API access per
      // ASPSP — typically a handful of calls/day, exact quota set by each
      // bank — so this is expected to trip occasionally now that import-all
      // runs every 4h instead of once. Surfaced as its own error so the
      // cron log and per-connection results in import-all read clearly
      // instead of a generic failure, and the run after just retries.
      const retryAfter = res.headers.get("retry-after");
      throw new Error(
        `Enable Banking ${options.method ?? "GET"} ${path} -> 429 (limite de requêtes atteinte auprès de la banque)` +
          (retryAfter ? `, retry-after: ${retryAfter}` : "") +
          (text ? `: ${text}` : "")
      );
    }
    throw new Error(`Enable Banking ${options.method ?? "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

export interface Aspsp {
  name: string;
  country: string;
  logo?: string;
  bic?: string;
}

export async function listAspsps(country: string): Promise<Aspsp[]> {
  const data = (await ebFetch(`/aspsps?country=${encodeURIComponent(country)}`)) as { aspsps: Aspsp[] };
  return data.aspsps;
}

export async function startAuth(params: {
  aspspName: string;
  aspspCountry: string;
  redirectUrl: string;
  state: string;
  validDays: number;
}): Promise<{ url: string; authorizationId: string }> {
  const validUntil = new Date(Date.now() + params.validDays * 24 * 60 * 60 * 1000).toISOString();
  const data = (await ebFetch("/auth", {
    method: "POST",
    body: {
      access: { valid_until: validUntil },
      aspsp: { name: params.aspspName, country: params.aspspCountry },
      state: params.state,
      redirect_url: params.redirectUrl,
      psu_type: "personal",
    },
  })) as { url: string; authorization_id: string };
  return { url: data.url, authorizationId: data.authorization_id };
}

export interface EnableBankingAccount {
  uid: string;
  name?: string;
  currency?: string;
  account_id: { iban?: string };
}

export async function exchangeSession(code: string): Promise<{
  sessionId: string;
  accounts: EnableBankingAccount[];
  aspsp: { name: string; country: string };
  validUntil?: string;
}> {
  const data = (await ebFetch("/sessions", { method: "POST", body: { code } })) as {
    session_id: string;
    accounts: EnableBankingAccount[];
    aspsp: { name: string; country: string };
    access?: { valid_until?: string };
  };
  return {
    sessionId: data.session_id,
    accounts: data.accounts,
    aspsp: data.aspsp,
    validUntil: data.access?.valid_until,
  };
}

export interface EnableBankingTransaction {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: { currency: string; amount: string };
  credit_debit_indicator: "CRDT" | "DBIT";
  status: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  creditor?: { name?: string };
  debtor?: { name?: string };
  creditor_account?: { iban?: string };
  debtor_account?: { iban?: string };
  remittance_information?: string[];
  bank_transaction_code?: { description?: string };
}

export async function fetchTransactions(
  accountUid: string,
  opts: { dateFrom?: string; dateTo?: string } = {}
): Promise<EnableBankingTransaction[]> {
  const all: EnableBankingTransaction[] = [];
  let continuationKey: string | undefined;
  do {
    const params = new URLSearchParams();
    if (opts.dateFrom) params.set("date_from", opts.dateFrom);
    if (opts.dateTo) params.set("date_to", opts.dateTo);
    if (continuationKey) params.set("continuation_key", continuationKey);
    const data = (await ebFetch(`/accounts/${accountUid}/transactions?${params.toString()}`)) as {
      transactions: EnableBankingTransaction[];
      continuation_key?: string;
    };
    all.push(...data.transactions);
    continuationKey = data.continuation_key;
  } while (continuationKey);
  return all;
}

export function newState(): string {
  return randomUUID();
}
