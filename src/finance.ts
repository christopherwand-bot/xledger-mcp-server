import type { Node } from "./pagination.js";

// Xledger monetary values have four decimal places. Never sum money using
// binary floating-point or convert missing/malformed amounts into zero.
export function amountUnits(value: unknown): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(String(value));
  if (!match) throw new Error("Xledger returned a missing or invalid monetary amount");
  const units = BigInt(match[2]) * 10_000n + BigInt((match[3] || "").padEnd(4, "0"));
  return match[1] ? -units : units;
}

export function money(units: bigint): string {
  const cents = ((units < 0n ? -units : units) + 50n) / 100n;
  return `${units < 0n && cents !== 0n ? "-" : ""}${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

export function listResult(items: Node[], first: number, source: string, sourceTruncated = false) {
  const limited = items.length > first;
  const returned = items.slice(0, first);
  return {
    items: returned,
    returned: returned.length,
    matchedFetched: items.length,
    sourceComplete: !sourceTruncated,
    complete: !sourceTruncated && !limited,
    hasMore: sourceTruncated || limited,
    ...(sourceTruncated || limited ? {
      warning: `${source}: this is an incomplete row selection, not a total. ${sourceTruncated ? "More source rows may exist; narrow the query." : "Increase first to return the remaining matched rows."}`,
    } : {}),
  };
}

export const openBalanceFilter = 'OR: [{ invoiceRemaining_gt: "0" }, { invoiceRemaining_lt: "0" }]';

type InvoiceBucket = { invoiced: bigint; outstanding: bigint; invoiceCount: number };
const emptyBucket = (): InvoiceBucket => ({ invoiced: 0n, outstanding: 0n, invoiceCount: 0 });
const bucketJson = (b: InvoiceBucket) => ({ numberedTransactionAmount: money(b.invoiced), remainingBalance: money(b.outstanding), numberedTransactionCount: b.invoiceCount });

export function summarizeInvoices(rows: Node[], truncated = false) {
  const currencies = new Map<string, InvoiceBucket>();
  const customers = new Map<string, InvoiceBucket & { customer: string; currency: string }>();
  let excludedTransactionCount = 0;
  for (const row of rows) {
    // AR also contains settlement and correction rows. They are not invoices.
    // This does not assume that every unnumbered row is a payment.
    if (!row.invoiceNumber || String(row.invoiceNumber).trim() === "0" || !String(row.invoiceNumber).trim()) {
      excludedTransactionCount++;
      continue;
    }
    const currency = row.currency?.code;
    if (typeof currency !== "string" || !currency) throw new Error("Invoice currency is missing; amounts cannot be safely aggregated");
    const customer = row.subledger?.description || "Unknown";
    const key = JSON.stringify([customer, currency]);
    if (!currencies.has(currency)) currencies.set(currency, emptyBucket());
    if (!customers.has(key)) customers.set(key, { ...emptyBucket(), customer, currency });
    const amount = amountUnits(row.invoiceAmount);
    const remaining = amountUnits(row.invoiceRemaining);
    for (const bucket of [currencies.get(currency)!, customers.get(key)!]) {
      bucket.invoiced += amount;
      bucket.outstanding += remaining;
      bucket.invoiceCount++;
    }
  }
  const byCurrency = [...currencies].map(([currency, bucket]) => ({ currency, ...bucketJson(bucket) }));
  return {
    basis: "AR transactions with invoice numbers. This is not booked revenue, net sales or a verified invoice-only view. Unnumbered rows are excluded; numbered settlement/correction rows cannot be ruled out without transaction-type verification.",
    invoiceClassificationVerified: false,
    complete: !truncated,
    transactionCount: rows.length,
    excludedTransactionCount,
    totals: byCurrency.length === 1 ? byCurrency[0] : null,
    byCurrency,
    byCustomer: [...customers.values()].sort((a, b) => a.invoiced > b.invoiced ? -1 : a.invoiced < b.invoiced ? 1 : 0)
      .map(({ customer, currency, ...bucket }) => ({ customer, currency, ...bucketJson(bucket) })),
    ...(truncated ? { warning: "Source pagination was incomplete. Invoice totals are incomplete; narrow the date range." } : {}),
    ...(byCurrency.length > 1 ? { currencyNote: "Currencies are reported separately. There is no combined monetary total." } : {}),
  };
}

export function compareBalances(budgets: Node[], actuals: Node[]) {
  const accounts = new Map<string, { description: string; budget: bigint; actual: bigint; hasBudget: boolean }>();
  for (const [kind, nodes] of [["budget", budgets], ["actual", actuals]] as const) {
    for (const node of nodes) {
      const code = node.account?.code;
      if (!code) throw new Error("Account code is missing; balances cannot be safely grouped");
      if (!accounts.has(code)) accounts.set(code, { description: node.account?.description || "", budget: 0n, actual: 0n, hasBudget: false });
      const account = accounts.get(code)!;
      account[kind] += amountUnits(node.amount);
      if (kind === "budget") account.hasBudget = true;
    }
  }
  return [...accounts].sort(([a], [b]) => a.localeCompare(b)).map(([accountCode, account]) => ({
    accountCode,
    description: account.description,
    budget: account.hasBudget ? money(account.budget) : null,
    actual: money(account.actual),
    variance: account.hasBudget ? money(account.actual - account.budget) : null,
    budgetAvailable: account.hasBudget,
  }));
}
