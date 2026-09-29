import type { EnableBankingTransaction } from "./client.js";

export interface MappedTransaction {
  date: string;
  label: string;
  amount: number;
  bankCategory?: string;
  isExcluded: boolean;
  externalId: string;
}

// Berlin Group transactions carry the counterpart's name, not a merchant
// label — for a debit the interesting name is the creditor (who got paid),
// for a credit it's the debtor (who paid us). Falls back to the free-text
// remittance information when the bank doesn't send a name.
export function mapTransaction(tx: EnableBankingTransaction, ownIbans: Set<string>): MappedTransaction | null {
  const externalId = tx.entry_reference || tx.transaction_id;
  if (!externalId) return null;

  const isDebit = tx.credit_debit_indicator === "DBIT";
  const amount = Number.parseFloat(tx.transaction_amount.amount) * (isDebit ? -1 : 1);
  if (Number.isNaN(amount)) return null;

  // transaction_date is the actual operation date (equivalent to the CSV
  // export's "Date operation"); booking_date/value_date are bank posting
  // dates and can land a transaction in the wrong month — same bug already
  // found and fixed once in csv.ts, avoided here by the same field priority.
  const date = tx.transaction_date || tx.booking_date || tx.value_date;
  if (!date) return null;

  const counterpart = isDebit ? tx.creditor : tx.debtor;
  const remittance = Array.isArray(tx.remittance_information) ? tx.remittance_information.join(" ").trim() : "";
  const label = counterpart?.name?.trim() || remittance || "Transaction";

  const creditorIban = tx.creditor_account?.iban;
  const debtorIban = tx.debtor_account?.iban;
  const isExcluded = Boolean(creditorIban && debtorIban && ownIbans.has(creditorIban) && ownIbans.has(debtorIban));

  return {
    date,
    label,
    amount,
    bankCategory: tx.bank_transaction_code?.description,
    isExcluded,
    externalId,
  };
}
