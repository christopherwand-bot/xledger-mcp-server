import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import {
  accountingList, addOperatingText, apClassification, apTransactionKind,
  currentAccountingEntity, readAPTransactions, readPostedTransactions, reconcileAccountingRows,
  resolveAccountingPeriod,
} from "../src/accounting.js";
import type { GqlRunner } from "../src/graphql.js";
import type { PagedNodes } from "../src/pagination.js";

const period = { dbId: 88, fiscalYear: 2026, fiscalPeriod: 8, code: "2608", description: "Aug/2026", fromDate: "2026-08-01", toDate: "2026-08-31" };
const request = { fiscalYear: 2026, periodNumber: 8, periodId: 88 };
const header = { dbId: 70, ownerDbId: 7, transactionNumber: 12, fiscalYear: 2025, fiscalPeriod: 12,
  postedDate: "2025-12-31", transactionSource: { code: "AP", description: "Supplier entry" } };
const gl = (dbId: number, code = "4300", amount = "1.0000", extra: Record<string, unknown> = {}) => ({
  dbId: String(dbId), ownerDbId: 7, periodId: 88, periodNumber: 8, monthNumber: 8,
  accountDbId: Number(code), headerDbId: 70, account: { code, description: "Synthetic account" },
  amount, invoiceAmount: amount, taxAmount: "0.0000", currency: { code: "NOK" }, header, ...extra,
});
const balance = (dbId: number, code = "4300", amount = "1.0000", extra: Record<string, unknown> = {}) => ({
  dbId, ownerDbId: 7, periodId: 88, fiscalYear: 2026, periodNumber: 8, amount,
  accountDbId: Number(code), account: { code, description: "Synthetic account" }, ...extra,
});
const ap = (dbId: number, kind: string | null = "INVOICE", amount = "-1.0000", extra: Record<string, unknown> = {}) => ({
  dbId, ownerDbId: 7, periodDbId: 88, transactionHeaderDbId: 70, transactionHeader: header,
  subledgerDbId: 33, subledger: { description: "Synthetic supplier" }, invoiceNumber: "SYN-123",
  invoiceDate: "2026-08-10", invoiceAmount: amount, invoiceRemaining: "0.0000", amount,
  account: { code: "2400" }, currency: { code: "NOK" }, slTransactionType: kind ? { code: null, name: kind } : null, ...extra,
});
const paged = (rows: any[], truncated = false) => Object.defineProperty(rows, "truncated", { value: truncated }) as PagedNodes;
const page = (root: string, rows: any[] | null, more = false) => ({ [root]: {
  pageInfo: { hasNextPage: more }, edges: rows?.map(node => ({ cursor: `c${node.dbId}`, node })) ?? null,
} });
function api(options: { gl?: any[]; balances?: any[]; ap?: any[] } = {}) {
  return vi.fn(async (q: string) => {
    if (q.includes("entities(")) return page("entities", [{ dbId: 7 }]);
    if (q.includes("period(dbId:")) return { period };
    if (q.includes("accountBalances(")) return page("accountBalances", options.balances ?? [balance(1)]);
    if (q.includes("apTransactions(")) return page("apTransactions", options.ap ?? [ap(3)]);
    if (q.includes("transactions(")) return page("transactions", options.gl ?? [gl(2)]);
    throw new Error("Unexpected synthetic query");
  });
}
const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const s of sessions.splice(0)) await s.close(); vi.unstubAllEnvs(); });
async function connect(run: GqlRunner) {
  vi.stubEnv("XLEDGER_ENABLE_PERSONNEL_TOOLS", "");
  const server = createMcpServer(run), client = new Client({ name: "posted-accounting-test", version: "1" });
  const [st, ct] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct); sessions.push(client, server);
  return { client, call: async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as any[]).find(c => c.type === "text")?.text;
    return { error: result.isError === true, data: result.isError ? text : JSON.parse(text) };
  } };
}

describe("CURRENT-entity posted accounting", () => {
  it("uses the row period even when the header date/year/period differ; requires no Project or personnel access", async () => {
    const run = api(); const { client, call } = await connect(run);
    const result = await call("get_posted_transactions", request);
    expect(result.error).toBe(false);
    expect(result.data).toMatchObject({ ownerDbId: 7, period, source: "transactions", complete: true, textFieldsIncluded: false });
    expect(result.data.items[0].header.fiscalYear).toBe(2025);
    const queries = run.mock.calls.map(([q]) => q);
    expect(queries.find(q => q.includes("transactions("))).toContain("periodId: 88");
    expect(queries.find(q => q.includes("transactions("))).toContain("ownerDbId: 7");
    expect(queries.every(q => !/\b(project|employee|text)\b/.test(q))).toBe(true);
    expect(queries.every(q => !q.includes("createdAt_") && !q.includes("journalEntries("))).toBe(true);
    const tools = (await client.listTools()).tools;
    expect(tools.find(t => t.name === "get_posted_transactions")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find(t => t.name === "reconcile_posted_period")?.annotations?.readOnlyHint).toBe(true);
  });

  it("discovers the period from balances without treating the company dimension as entity ownership", async () => {
    const run = api({ balances: [balance(1, "4300", "1", { company: { description: "Different counterparty" } }),
      balance(2, "4300", "2", { fiscalYear: 2025, periodId: 77 })] });
    const result = await resolveAccountingPeriod(run, 7, { fiscalYear: 2026, periodNumber: 8 });
    expect(result.period.dbId).toBe(88); expect(result.balances).toHaveLength(1);
  });

  it.each([{ rows: [] }, { rows: [{ dbId: 7 }, { dbId: 8 }] }, { rows: [{ dbId: null }] }])("refuses an unverified current entity: %j", async ({ rows }) => {
    await expect(currentAccountingEntity(async () => page("entities", rows))).rejects.toThrow("Exactly one CURRENT");
  });
  it.each([
    ["owner", { ownerDbId: 8 }], ["period", { periodId: 99 }],
    ["header owner", { header: { ...header, ownerDbId: 8 } }],
    ["header ID", { header: { ...header, dbId: 71 } }],
  ])("rejects a %s mismatch", async (_label, extra) => {
    await expect(readPostedTransactions(api({ gl: [gl(1, "4300", "1", extra)] }), 7, period)).rejects.toThrow(/mismatch|outside/);
  });
  it("checks supplied period IDs instead of trusting them", async () => {
    await expect(resolveAccountingPeriod(async () => ({ period: { ...period, fiscalPeriod: 9 } }), 7, request)).rejects.toThrow("period identity");
  });
  it("does not guess a period or zero when balances are missing", async () => {
    await expect(resolveAccountingPeriod(api({ balances: [] }), 7, { fiscalYear: 2026, periodNumber: 8 })).rejects.toThrow("not a verified zero");
  });
  it("does not hide missing connections or metadata as empty complete data", async () => {
    await expect(readPostedTransactions(async () => ({}), 7, period)).rejects.toThrow("no verified zero");
    await expect(readPostedTransactions(async () => ({ transactions: { edges: [] } }), 7, period)).rejects.toThrow("no verified zero");
  });
  it("propagates a permissions error without using an unscoped fallback", async () => {
    const run = vi.fn(async () => { throw new Error("Transaction permission denied"); });
    await expect(readPostedTransactions(run, 7, period)).rejects.toThrow("permission denied");
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("follows source cursors before applying output offsets and never labels the last slice complete", async () => {
    const run = vi.fn(async q => q.includes("after:") ? page("transactions", [gl(3)]) : page("transactions", [gl(1), gl(2)], true));
    const rows = await readPostedTransactions(run, 7, period);
    const first = accountingList(rows, 2, 0, "transactions", rows.truncated);
    const last = accountingList(rows, 2, first.nextOffset!, "transactions", rows.truncated);
    expect(first).toMatchObject({ sourceComplete: true, complete: false, matchedFetched: 3, nextOffset: 2 });
    expect(last).toMatchObject({ sourceComplete: true, complete: false, nextOffset: null, hasMore: false });
    expect([...first.items, ...last.items].map(x => x.dbId)).toEqual(["1", "2", "3"]);
  });
  it("rejects repeated row IDs across advancing pages", async () => {
    const run = vi.fn(async q => q.includes("after:") ? page("transactions", [gl(1), gl(3)]) : page("transactions", [gl(1), gl(2)], true));
    await expect(readPostedTransactions(run, 7, period)).rejects.toThrow("repeated record IDs");
  });
  it("cannot pass a period control when the pagination budget was exhausted", async () => {
    let n = 0;
    const rows = await readPostedTransactions(async () => page("transactions", [gl(++n)], true), 7, period);
    expect(rows.truncated).toBe(true);
    const result = reconcileAccountingRows(rows, paged([balance(1)]), paged([ap(2)]));
    expect(result).toMatchObject({ complete: false, status: "incomplete", postedSignedSum: null, postedDebitsEqualCredits: null });
    expect(result.accounts.every(x => x.matches === null)).toBe(true);
  });
});

describe("AP identity, classification and filters", () => {
  it("distinguishes numbered payments, credits, payroll and unknown rows without inferring from the invoice number", () => {
    const rows = [ap(1), ap(2, "MANUAL_PAYMENT", "1"), ap(3, "ELECTRONIC_PAYMENT", "1"),
      ap(4, "CREDIT_MEMO", "1"), ap(5, "PAYROLL"), ap(6, null), ap(7, "UNRECOGNISED")];
    expect(rows.map(apTransactionKind)).toEqual(["invoice", "payment", "payment", "credit_note", "payroll", "unknown", "other"]);
    expect(apClassification(rows).counts).toEqual({ invoice: 1, payment: 2, credit_note: 1, payroll: 1, unknown: 1, other: 1 });
  });
  it("returns matched source references through the AP MCP tool and follows output pages", async () => {
    const run = api({ ap: [ap(1), ap(2, "MANUAL_PAYMENT", "1", { matchId: 99 })] });
    const { call } = await connect(run);
    const result = await call("get_ap_transactions", { ...request, first: 1 });
    expect(result.error).toBe(false);
    expect(result.data.items[0]).toMatchObject({ transactionKind: "invoice", transactionHeaderDbId: 70, subledgerDbId: 33 });
    expect(result.data).toMatchObject({ complete: false, nextOffset: 1, classification: { counts: { invoice: 1, payment: 1 } } });
    expect(run.mock.calls.find(([q]) => q.includes("apTransactions("))![0]).toContain("periodDbId: 88");
  });
  it.each([
    { supplierId: 34 }, { headerDbId: 71 }, { fromDate: "2026-08-11" }, { toDate: "2026-08-09" },
  ])("does not accept ignored AP filters %j", async filter => {
    await expect(readAPTransactions(api(), 7, filter)).rejects.toThrow("outside");
  });
  it("requires the AP row's accounting period and does not require an August invoice date", async () => {
    const rows = await readAPTransactions(api({ ap: [ap(1, "INVOICE", "-1", { invoiceDate: "2026-07-31" })] }), 7, { period });
    expect(rows).toHaveLength(1);
    await expect(readAPTransactions(api({ ap: [ap(1, "INVOICE", "-1", { periodDbId: 87 })] }), 7, { period })).rejects.toThrow("outside");
  });
});

describe("period reconciliation and optional operating text", () => {
  it("matches dimension-split balances and AP independently in exact four-decimal arithmetic through MCP", async () => {
    const run = api({ gl: [gl(1, "4300", "0.1001"), gl(2, "4300", "0.2000"), gl(3, "2400", "-0.3001")],
      balances: [balance(1, "4300", "0.1000"), balance(2, "4300", "0.2001"), balance(3, "2400", "-0.3001")],
      ap: [ap(1, "INVOICE", "-0.3001")] });
    const { call } = await connect(run);
    const result = await call("reconcile_posted_period", request);
    expect(result.error).toBe(false);
    expect(result.data).toMatchObject({ status: "matched", complete: true, postedSignedSum: "0.0000", postedDebitsEqualCredits: true, independentReportReconciliation: false });
    expect(result.data.accounts.find((x: any) => x.accountCode === "4300")).toMatchObject({ postedAmount: "0.3001", balanceAmount: "0.3001", difference: "0.0000", matches: true });
    expect(result.data.apAccounts[0].matches).toBe(true);
  });
  it("does not round away a discrepancy smaller than one cent", () => {
    const result = reconcileAccountingRows(paged([gl(1)]), paged([balance(1, "4300", "1.0001")]), paged([ap(1)]));
    expect(result.status).toBe("differences");
    expect(result.accounts.find(x => x.accountCode === "4300")!.difference).toBe("-0.0001");
  });
  it("keeps missing account amounts null and refuses malformed amounts", () => {
    const result = reconcileAccountingRows(paged([gl(1)]), paged([balance(1, "2400", "-1")]), paged([ap(1)]));
    expect(result.accounts.find(x => x.accountCode === "4300")!.balanceAmount).toBeNull();
    expect(() => reconcileAccountingRows(paged([gl(1, "4300", "")]), paged([balance(1)]), paged([ap(1)]))).toThrow("invalid monetary");
  });
  it("returns unavailable controls for empty data instead of a successful zero", () => {
    const result = reconcileAccountingRows(paged([]), paged([]), paged([]));
    expect(result).toMatchObject({ postedSignedSum: null, postedDebitsEqualCredits: null, apControlAvailable: false });
    expect(result.status).toContain("no verified zero");
  });
  it("marks zero-net GL accounts absent from balances as unavailable, not errors or verified zeros", () => {
    const result = reconcileAccountingRows(paged([gl(1, "4300", "1"), gl(2, "2400", "-1"), gl(3, "2600", "2"), gl(4, "2600", "-2")]),
      paged([balance(1, "4300", "1"), balance(2, "2400", "-1")]), paged([ap(1)]));
    expect(result).toMatchObject({ complete: true, controlsComplete: false, status: "checks_unavailable",
      accountControls: { matched: 2, differences: 0, unavailable: 1 }, apControls: { matched: 1, differences: 0, unavailable: 0 } });
    expect(result.accounts.find(x => x.accountCode === "2600")).toMatchObject({ postedAmount: "0.0000", balanceAmount: null,
      difference: null, matches: null, status: "missing_balance_rows" });
  });
  it("does not pass an unbalanced ledger even if both account sources match", () => {
    const result = reconcileAccountingRows(paged([gl(1, "2400", "1")]), paged([balance(1, "2400", "1")]), paged([ap(1, "INVOICE", "1")]));
    expect(result).toMatchObject({ status: "differences", postedDebitsEqualCredits: false });
  });
  it("fetches text only for eligible output rows and withholds Norwegian health terms", async () => {
    const rows = [gl(1), gl(2, "5000"), gl(3, "1920"), gl(4, "6550"), gl(5, "6550", "1", { header: { ...header, transactionSource: { code: "PR" } } })];
    const run = vi.fn(async q => {
      expect(q).not.toContain('"2"'); expect(q).not.toContain('"3"'); expect(q).not.toContain('"5"');
      return page("transactions", [{ dbId: "1", ownerDbId: 7, text: "Synthetic operating service" },
        { dbId: "4", ownerDbId: 7, text: "Sykepenger for ansatt" }]);
    });
    const coverage = await addOperatingText(run, 7, rows, "transactions");
    expect(coverage).toMatchObject({ eligibleRows: 2, redactedRows: 1 });
    expect(rows[0].text).toBe("Synthetic operating service");
    expect(rows[1].textStatus).toBe("excluded_account_or_source");
    expect(rows[3].textStatus).toBe("redacted"); expect(rows[3]).not.toHaveProperty("text");
  });
  it.each([
    ["get_posted_transactions", { fiscalYear: 2026, periodNumber: 13 }],
    ["get_posted_transactions", { ...request, headerDbId: '1} mutation {' }],
    ["get_posted_transactions", { ...request, offset: -1 }],
    ["reconcile_posted_period", { fiscalYear: 2026 }],
    ["get_ap_transactions", { fiscalYear: 2026 }],
    ["get_ap_transactions", { periodId: 88 }],
  ])("rejects invalid %s input before making an API request", async (name, args) => {
    const run = vi.fn(); const { call } = await connect(run);
    expect((await call(name, args)).error).toBe(true); expect(run).not.toHaveBeenCalled();
  });
});
