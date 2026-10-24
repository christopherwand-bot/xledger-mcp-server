/** Posted-period reads, distinct from the journalEntries work/journal view. */
import type { GqlRunner } from "./graphql.js";
import { amountUnits, openBalanceFilter } from "./finance.js";
import { paginateAll, type Node, type PagedNodes } from "./pagination.js";
import { positiveId } from "./invoice-source.js";
import { validateDateRange } from "./validation.js";
import { ABSENCE_RE, HEALTH_RE, NON_HEALTH_RE, norm } from "./absences.js";

export interface AccountingPeriod {
  dbId: number; fiscalYear: number; fiscalPeriod: number;
  code: string | null; description: string | null; fromDate: string; toDate: string;
}
export interface PeriodRequest { fiscalYear: number; periodNumber: number; periodId?: number }
const PAGE_SIZE = 500;
const BALANCE_FIELDS = "dbId ownerDbId fiscalYear periodNumber periodId accountDbId amount quantity account { code description }";
const HEADER_FIELDS = "dbId ownerDbId transactionNumber fiscalYear fiscalPeriod postedDate transactionSource { code description }";

function assertPeriodRequest(options: PeriodRequest) {
  if (!Number.isInteger(options.fiscalYear) || options.fiscalYear < 1900 || options.fiscalYear > 9999 ||
      !Number.isInteger(options.periodNumber) || options.periodNumber < 1 || options.periodNumber > 12)
    throw new Error("A fiscal year and periodNumber 1–12 are required");
  if (options.periodId !== undefined) positiveId(String(options.periodId));
}

export async function currentAccountingEntity(run: GqlRunner): Promise<number> {
  const data = await run("{ entities(first: 2, ownerSet: CURRENT) { edges { node { dbId } } } }");
  const rows = data.entities?.edges;
  if (!Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(rows[0]?.node?.dbId))
    throw new Error("Exactly one CURRENT entity must be verified before reading accounting data");
  return Number(positiveId(String(rows[0].node.dbId)));
}

/** Reject malformed pages and cross-owner rows; never turn a missing root into zero. */
async function scopedRows(run: GqlRunner, root: string, owner: number, filters: string[], fields: string, order = "") {
  positiveId(String(owner));
  const rows = await paginateAll(run, after => `{
    ${root}(first: ${PAGE_SIZE}${after}, ownerSet: CURRENT, filter: { ownerDbId: ${owner}${filters.length ? ", " + filters.join(", ") : ""} }${order}) {
      pageInfo { hasNextPage } edges { cursor node { ${fields} } }
    }
  }`, data => {
    const c = data[root];
    if (!c || typeof c.pageInfo?.hasNextPage !== "boolean" ||
        !(Array.isArray(c.edges) || (c.edges === null && !c.pageInfo.hasNextPage)))
      throw new Error(`Invalid or inaccessible ${root} connection; no verified zero`);
    if ((c.edges?.length || 0) > PAGE_SIZE) throw new Error(`${root} page exceeds the requested size`);
    for (const e of c.edges || []) {
      const row = e?.node;
      if (!row || row.ownerDbId !== owner || !/^[1-9]\d{0,18}$/.test(String(row.dbId)))
        throw new Error(`${root} record identity/owner mismatch`);
    }
    return c;
  });
  if (new Set(rows.map(row => String(row.dbId))).size !== rows.length)
    throw new Error(`${root} contains repeated record IDs across pages`);
  return rows;
}

export async function resolveAccountingPeriod(run: GqlRunner, owner: number, options: PeriodRequest) {
  assertPeriodRequest(options);
  let periodId = options.periodId;
  let balances: PagedNodes | undefined;
  if (periodId === undefined) {
    const all = await scopedRows(run, "accountBalances", owner, [], BALANCE_FIELDS,
      ", orderBy: [{ field: PERIOD_ID, direction: DESC }]");
    if (all.truncated) throw new Error("Period discovery is incomplete; supply a verified periodId with the year and periodNumber");
    const selected = all.filter(row => row.fiscalYear === options.fiscalYear && row.periodNumber === options.periodNumber);
    const ids = new Set(selected.map(row => Number(positiveId(String(row.periodId)))));
    if (ids.size !== 1) throw new Error("The requested accounting period could not be uniquely verified from balances; supply its periodId. Missing rows are not a verified zero");
    periodId = [...ids][0];
    balances = Object.defineProperty(selected, "truncated", { value: false }) as PagedNodes;
  }
  const data = await run(`{ period(dbId: ${periodId}) { dbId code description fiscalYear fiscalPeriod fromDate toDate } }`);
  const p = data.period;
  if (!p || String(p.dbId) !== String(periodId) || p.fiscalYear !== options.fiscalYear || p.fiscalPeriod !== options.periodNumber)
    throw new Error("Accounting period identity/year/number mismatch or missing read access");
  validateDateRange(p.fromDate, p.toDate);
  if (!p.fromDate || !p.toDate) throw new Error("Accounting period dates are missing");
  const period = { ...p, dbId: periodId } as AccountingPeriod;
  return { period, balances };
}

function assertHeader(row: Node, headerKey: string, idKey: string, owner: number) {
  const h = row[headerKey];
  if (!h || h.ownerDbId !== owner || String(h.dbId) !== String(row[idKey]))
    throw new Error("Transaction header identity/owner mismatch or missing read access");
}

export async function readPostedTransactions(run: GqlRunner, owner: number, period: AccountingPeriod,
  options: { accountDbId?: number; headerDbId?: number } = {}) {
  const filters = [`periodId: ${period.dbId}`];
  if (options.accountDbId !== undefined) filters.push(`accountDbId: ${positiveId(String(options.accountDbId))}`);
  if (options.headerDbId !== undefined) filters.push(`headerDbId: ${positiveId(String(options.headerDbId))}`);
  const rows = await scopedRows(run, "transactions", owner, filters,
    `dbId ownerDbId periodId periodNumber monthNumber accountDbId headerDbId amount invoiceAmount taxAmount quantity
     account { code description } currency { code } header { ${HEADER_FIELDS} }`);
  for (const row of rows) {
    if (row.periodId !== period.dbId || (options.accountDbId !== undefined && row.accountDbId !== options.accountDbId) ||
        (options.headerDbId !== undefined && row.headerDbId !== options.headerDbId))
      throw new Error("Posted transaction falls outside the requested period/account/header");
    assertHeader(row, "header", "headerDbId", owner);
  }
  return rows;
}

export async function readPeriodBalances(run: GqlRunner, owner: number, period: AccountingPeriod) {
  const rows = await scopedRows(run, "accountBalances", owner, [`periodId: ${period.dbId}`], BALANCE_FIELDS);
  for (const row of rows) if (row.periodId !== period.dbId || row.fiscalYear !== period.fiscalYear || row.periodNumber !== period.fiscalPeriod)
    throw new Error("Account balance falls outside the requested period");
  return rows;
}

export type APKind = "invoice" | "credit_note" | "payment" | "payroll" | "other" | "unknown";
export function apTransactionKind(row: Node): APKind {
  const name = row.slTransactionType?.name;
  const code = row.slTransactionType?.code;
  const type = String(name || code || "").toUpperCase();
  if (type === "INVOICE") return "invoice";
  if (type === "CREDIT_MEMO" || type === "CREDIT_NOTE") return "credit_note";
  if (["ELECTRONIC_PAYMENT", "MANUAL_PAYMENT", "PAYMENT"].includes(type)) return "payment";
  if (type === "PAYROLL") return "payroll";
  return type ? "other" : "unknown";
}

export interface APRequest {
  fromDate?: string; toDate?: string; outstandingOnly?: boolean;
  supplierId?: number; headerDbId?: number; period?: AccountingPeriod;
}
export async function readAPTransactions(run: GqlRunner, owner: number, options: APRequest = {}) {
  validateDateRange(options.fromDate, options.toDate);
  const filters: string[] = [];
  if (options.period) filters.push(`periodDbId: ${options.period.dbId}`);
  if (options.outstandingOnly) filters.push(openBalanceFilter);
  if (options.fromDate) filters.push(`invoiceDate_gte: ${JSON.stringify(options.fromDate)}`);
  if (options.toDate) filters.push(`invoiceDate_lte: ${JSON.stringify(options.toDate)}`);
  if (options.supplierId !== undefined) filters.push(`subledgerDbId: ${positiveId(String(options.supplierId))}`);
  if (options.headerDbId !== undefined) filters.push(`transactionHeaderDbId: ${positiveId(String(options.headerDbId))}`);
  const rows = await scopedRows(run, "apTransactions", owner, filters,
    `dbId ownerDbId invoiceNumber invoiceDate dueDate invoiceAmount invoiceRemaining amount reconciled matchId
     subledgerDbId transactionHeaderDbId periodDbId paymentDate lastPaymentDate
     slTransactionType { code name } ledgerType { code name } paymentStatus { code name }
     subledger { description } currency { code } account { code description }
     transactionHeader { ${HEADER_FIELDS} }`, ", orderBy: [{ field: MODIFIED_AT, direction: DESC }]");
  for (const row of rows) {
    if ((options.period && row.periodDbId !== options.period.dbId) ||
        (options.supplierId !== undefined && row.subledgerDbId !== options.supplierId) ||
        (options.headerDbId !== undefined && row.transactionHeaderDbId !== options.headerDbId) ||
        (options.fromDate && (!row.invoiceDate || row.invoiceDate < options.fromDate)) ||
        (options.toDate && (!row.invoiceDate || row.invoiceDate > options.toDate)))
      throw new Error("AP transaction falls outside the requested supplier/header/period/date range");
    assertHeader(row, "transactionHeader", "transactionHeaderDbId", owner);
    if (options.outstandingOnly && amountUnits(row.invoiceRemaining) === 0n)
      throw new Error("AP returned a zero balance for an outstanding-only request");
    row.transactionKind = apTransactionKind(row);
  }
  return rows;
}

export function apClassification(rows: Node[], truncated = false) {
  const counts: Record<APKind, number> = { invoice: 0, credit_note: 0, payment: 0, payroll: 0, other: 0, unknown: 0 };
  for (const row of rows) counts[apTransactionKind(row)]++;
  return { counts, complete: !truncated, basis: "Xledger slTransactionType; an invoice number alone does not identify an invoice",
    note: "Repeated invoice numbers, matching amounts or shared matchId/header IDs do not prove duplicate invoices. Inspect transaction type, signed amounts and the original documents." };
}

/** Output pages are distinct from fetching all source pages. No false complete on the last slice. */
export function accountingList(rows: Node[], first: number, offset: number, source: string, truncated = false) {
  if (offset > rows.length) throw new Error("Output offset exceeds fetched rows; use the preceding nextOffset");
  const items = rows.slice(offset, offset + first);
  const nextOffset = offset + items.length < rows.length ? offset + items.length : null;
  const complete = !truncated && offset === 0 && items.length === rows.length;
  return { items, returned: items.length, matchedFetched: rows.length, sourceComplete: !truncated, complete,
    offset, nextOffset, hasMore: nextOffset !== null || truncated,
    dataStatus: rows.length ? "rows_returned" : "no_rows_returned; not independently verified zero",
    ...(!complete ? { warning: `${source}: this output is a partial row selection, not a total. ${truncated ? "Source pagination was incomplete; narrow by accountDbId/headerDbId or period." : "Read every output page before calculating totals."}` } : {}) };
}

// Optional text is limited to non-payroll purchases/operating/finance accounts.
// No Employee, Subledger, Product or Project master access is required for GL reads.
const NORWEGIAN_HEALTH = /syk|sjuk|frav(?:a|ae|æ)r|lege|tannlege|diagnos|behandl|helse|omsorg|permisjon|foreldre|ferie/;
export async function addOperatingText(run: GqlRunner, owner: number, rows: Node[], source: "transactions" | "apTransactions") {
  const eligible = rows.filter(row => source === "transactions"
    ? /^[4678]/.test(String(row.account?.code || "")) && Boolean(row.header?.transactionSource?.code) && row.header.transactionSource.code !== "PR"
    : ["2400", "2460"].includes(String(row.account?.code)) && apTransactionKind(row) !== "payroll");
  const wanted = new Map(eligible.map(row => [String(row.dbId), row]));
  for (const row of rows) { delete row.text; row.textStatus = "excluded_account_or_source"; }
  let redacted = 0;
  for (let start = 0; start < eligible.length; start += 100) {
    const ids = eligible.slice(start, start + 100).map(row => String(row.dbId));
    const literals = source === "transactions" ? JSON.stringify(ids) : `[${ids.map(positiveId).join(",")}]`;
    const texts = await scopedRows(run, source, owner, [`dbId_in: ${literals}`], "dbId ownerDbId text");
    if (texts.truncated || texts.length !== ids.length || texts.some(row => !ids.includes(String(row.dbId))))
      throw new Error("Optional transaction text coverage is incomplete or returned unrelated records");
    for (const row of texts) {
      const target = wanted.get(String(row.dbId))!;
      if (row.text != null && typeof row.text !== "string") throw new Error("Invalid transaction text");
      const text = norm(row.text);
      if (ABSENCE_RE.test(text) || HEALTH_RE.test(text) || NON_HEALTH_RE.test(text) || NORWEGIAN_HEALTH.test(text)) {
        target.textStatus = "redacted"; redacted++;
      } else { target.text = row.text ?? null; target.textStatus = row.text ? "included" : "empty"; }
    }
  }
  return { eligibleRows: eligible.length, redactedRows: redacted,
    policy: "Opt-in text only: GL account classes 4/6/7/8 excluding payroll sources; AP accounts 2400/2460 excluding payroll. Recognised health/absence terms are withheld. No Project permission required. This keyword filter is not a general personal-data classifier." };
}

const exact = (v: bigint) => `${v < 0n ? "-" : ""}${(v < 0n ? -v : v) / 10000n}.${String((v < 0n ? -v : v) % 10000n).padStart(4, "0")}`;
function byAccount(rows: Node[]) {
  const sums = new Map<string, bigint>();
  for (const row of rows) {
    const code = row.account?.code;
    if (typeof code !== "string" || !code) throw new Error("Account code missing; cannot reconcile accounting data");
    sums.set(code, (sums.get(code) || 0n) + amountUnits(row.amount));
  }
  return sums;
}

/** Internal cross-endpoint checks, never an independent accounting audit. */
export function reconcileAccountingRows(posted: PagedNodes, balances: PagedNodes, ap: PagedNodes) {
  const complete = !posted.truncated && !balances.truncated && !ap.truncated;
  const available = complete && posted.length > 0 && balances.length > 0;
  const gl = byAccount(posted), bal = byAccount(balances), supplier = byAccount(ap);
  const accounts = [...new Set([...gl.keys(), ...bal.keys()])].sort().map(accountCode => {
    const a = gl.get(accountCode), b = bal.get(accountCode);
    const comparable = available && a !== undefined && b !== undefined;
    return { accountCode, postedRowsPresent: a !== undefined, balanceRowsPresent: b !== undefined,
      postedAmount: a === undefined ? null : exact(a), balanceAmount: b === undefined ? null : exact(b),
      difference: a === undefined || b === undefined ? null : exact(a - b),
      matches: comparable ? a === b : null,
      status: !available ? "unavailable" : a === undefined ? "missing_posted_rows" : b === undefined ? "missing_balance_rows" : a === b ? "matched" : "difference" };
  });
  const apAccounts = [...supplier.keys()].sort().map(accountCode => ({ accountCode,
    apAmount: exact(supplier.get(accountCode)!), postedAmount: gl.has(accountCode) ? exact(gl.get(accountCode)!) : null,
    difference: gl.has(accountCode) ? exact(supplier.get(accountCode)! - gl.get(accountCode)!) : null,
    matches: available && gl.has(accountCode) ? supplier.get(accountCode) === gl.get(accountCode) : null,
    status: !available ? "unavailable" : !gl.has(accountCode) ? "missing_posted_rows" : supplier.get(accountCode) === gl.get(accountCode) ? "matched" : "difference" }));
  const total = [...gl.values()].reduce((a, b) => a + b, 0n);
  const counts = (rows: Array<{ matches: boolean | null }>) => ({ matched: rows.filter(row => row.matches === true).length,
    differences: rows.filter(row => row.matches === false).length, unavailable: rows.filter(row => row.matches === null).length });
  const accountControls = counts(accounts), apControls = counts(apAccounts);
  const controlsComplete = available && accountControls.unavailable === 0 && ap.length > 0 && apControls.unavailable === 0;
  const differences = total !== 0n || accountControls.differences > 0 || apControls.differences > 0;
  return { basis: "Internal comparison of CURRENT-entity ledger amount fields from transactions, accountBalances and apTransactions; not an independent Xledger report reconciliation or proof of correct coding",
    complete, sourceComplete: complete, independentReportReconciliation: false,
    controlsComplete, status: !complete ? "incomplete" : !available ? "no_rows_returned; no verified zero" : differences ? "differences" : !controlsComplete ? "checks_unavailable" : "matched",
    sourceRows: { transactions: posted.length, accountBalances: balances.length, apTransactions: ap.length },
    postedSignedSum: available ? exact(total) : null, postedDebitsEqualCredits: available ? total === 0n : null,
    accounts, apAccounts, accountControls, apControls, apControlAvailable: available && apControls.matched + apControls.differences > 0,
    ...(!controlsComplete ? { warning: "Some controls lack complete comparable source rows. Read per-account status; a zero net movement does not establish that a missing balance row equals zero." } : {}),
    note: "Compare ledger amount, not invoiceAmount. AP also includes payroll/tax/settlement rows. Missing source/account rows remain explicit and are never substituted with verified zero. A balanced ledger does not prove that invoices or account choices are correct." };
}
