import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import type { GqlRunner } from "../src/graphql.js";

const sessions: Array<{ close: () => Promise<void> }> = [];
beforeEach(() => vi.stubEnv("XLEDGER_ENABLE_PERSONNEL_TOOLS", ""));
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.unstubAllEnvs();
});

function page(root: string, rows: any[], more = false) {
  return { [root]: { pageInfo: { hasNextPage: more }, edges: rows.map((node, i) => ({ cursor: `c${node.dbId || i}`, node })) } };
}

async function connect(run: GqlRunner) {
  const server = createMcpServer(run);
  const client = new Client({ name: "financial-regression-test", version: "1" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  sessions.push(client, server);
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as any[]).find(c => c.type === "text")?.text || "";
      return { error: result.isError || false, data: result.isError ? text : JSON.parse(text) };
    },
  };
}

describe("financial pilot through the actual MCP protocol", () => {
  it("returns BOTH negative supplier invoices and positive credit balances as open items", async () => {
    const input = [
      { dbId: 1, invoiceNumber: "TEST-INVOICE", invoiceRemaining: "-100.0000" },
      { dbId: 2, invoiceNumber: "TEST-CREDIT", invoiceRemaining: "25.0000" },
      { dbId: 3, invoiceNumber: "TEST-PAID", invoiceRemaining: "0.0000" },
    ];
    const run = vi.fn(async (query: string) => page("apTransactions", input.filter(row => {
      const value = Number(row.invoiceRemaining);
      return query.includes("OR:") && query.includes("invoiceRemaining_lt") ? value !== 0 : value > 0;
    })));
    const { call } = await connect(run);
    const result = await call("get_ap_transactions", { outstandingOnly: true, first: 10 });
    expect(result.error).toBe(false);
    expect(result.data.items.map((r: any) => r.invoiceNumber)).toEqual(["TEST-INVOICE", "TEST-CREDIT"]);
    expect(result.data.complete).toBe(true);
  });

  it.each([
    ["get_ar_transactions", { fromDate: "2026-02-30" }],
    ["get_ap_transactions", { fromDate: "2026-04-30", toDate: "2026-04-01" }],
    ["get_account_balances", { fiscalYear: 2026, periodNumber: 13 }],
    ["get_budget_vs_actual", { periodNumber: 0 }],
    ["get_ar_transactions", { first: -1 }],
    ["get_exchange_rates", { fromCurrency: 'NOK" injected' }],
  ])("rejects invalid input to %s before querying Xledger", async (name, args) => {
    const run = vi.fn();
    const { call } = await connect(run);
    expect((await call(name, args)).error).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("pages GL before matching fiscal year and does not require Project for the default query", async () => {
    const run = vi.fn(async (query: string) => {
      if (/\bproject\s*\{/.test(query)) throw new Error("No Project permission");
      return query.includes("after:") ? page("journalEntries", [{ dbId: 2, fiscalYear: 2026, amount: "25" }])
        : page("journalEntries", [{ dbId: 1, fiscalYear: 2025, amount: "10" }], true);
    });
    const { call } = await connect(run);
    const result = await call("get_journal_entries", { first: 1, fiscalYear: 2026 });
    expect(result.error).toBe(false);
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0].dbId).toBe(2);
    expect(result.data.projectFieldsIncluded).toBe(false);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("preserves Project access failures when explicitly requesting project fields", async () => {
    const run = vi.fn(async () => { throw new Error("No Project permission"); });
    const { call } = await connect(run);
    const result = await call("get_journal_entries", { includeProject: true });
    expect(result.error).toBe(true);
    expect(result.data).toContain("Project permission");
  });

  it("marks a limited balance output as incomplete", async () => {
    const run = vi.fn(async () => page("accountBalances", [
      { dbId: 1, fiscalYear: 2026, periodNumber: 4, amount: "1" },
      { dbId: 2, fiscalYear: 2026, periodNumber: 4, amount: "2" },
    ]));
    const { call } = await connect(run);
    expect((await call("get_account_balances", { first: 1, fiscalYear: 2026, periodNumber: 4 })).data)
      .toMatchObject({ returned: 1, matchedFetched: 2, hasMore: true, complete: false });
  });

  it("reports missing budgets as null while filtering the correct month", async () => {
    const run = vi.fn(async (query: string) => query.includes("budgetBalances") ? page("budgetBalances", []) : page("accountBalances", [
      { fiscalYear: 2026, periodNumber: 4, amount: "0.1", account: { code: "4000" } },
      { fiscalYear: 2026, periodNumber: 4, amount: "0.2", account: { code: "4000" } },
      { fiscalYear: 2026, periodNumber: 5, amount: "999", account: { code: "4000" } },
    ]));
    const { call } = await connect(run);
    const result = await call("get_budget_vs_actual", { fiscalYear: 2026, periodNumber: 4 });
    expect(result.data.rows).toEqual([expect.objectContaining({ accountCode: "4000", actual: "0.30", budget: null, variance: null })]);
    expect(result.data.budgetStatus).toBe("no_budget_rows_returned");
  });

  it("pages invoice summaries and excludes unnumbered settlement rows", async () => {
    const row = (dbId: number, invoiceNumber: string | null, invoiceAmount: string) => ({ dbId, invoiceNumber, invoiceAmount, invoiceRemaining: "0", currency: { code: "NOK" } });
    const run = vi.fn(async query => query.includes("after:")
      ? page("arTransactions", [row(3, "CREDIT", "-10")])
      : page("arTransactions", [row(1, "INV", "100"), row(2, null, "-100")], true));
    const { call } = await connect(run);
    const result = await call("get_revenue_summary", { fromDate: "2026-04-01", toDate: "2026-04-30" });
    expect(result.data.totals).toMatchObject({ numberedTransactionAmount: "90.00", numberedTransactionCount: 2 });
    expect(result.data.invoiceClassificationVerified).toBe(false);
    expect(result.data.excludedTransactionCount).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("does not silently switch from creation date to bank date on a failed request", async () => {
    const run = vi.fn(async () => { throw new Error("Filter permission error"); });
    const { call } = await connect(run);
    const result = await call("get_cash_transactions", { fromDate: "2026-04-01", toDate: "2026-04-30" });
    expect(result.error).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("hides personnel tools and refuses personnel deltas in the default pilot", async () => {
    vi.stubEnv("XLEDGER_ENABLE_PERSONNEL_TOOLS", "");
    const run = vi.fn();
    const { client, call } = await connect(run);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).not.toContain("get_employees");
    expect(names).not.toContain("get_absences");
    expect(names).not.toContain("get_expenses");
    expect(names).toContain("get_connection_info");
    expect(tools.every(t => t.annotations?.readOnlyHint === true)).toBe(true);
    expect((await call("get_deltas", { entity: "employees" })).error).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports the configured environment and actual current-entity lookup without exposing credentials", async () => {
    vi.stubEnv("XLEDGER_API_URL", "https://demo.xledger.net/graphql");
    vi.stubEnv("XLEDGER_GRAPHQL_TOKEN", "DO-NOT-EXPOSE-THIS-TEST-SECRET");
    const { call } = await connect(async () => page("entities", [{ dbId: 1, description: "Test Entity" }]));
    const result = await call("get_connection_info");
    expect(result.data).toMatchObject({ environment: "demo", entityLookup: "succeeded", personnelToolsEnabled: false });
    expect(JSON.stringify(result)).not.toContain("DO-NOT-EXPOSE");
  });

  it("distinguishes line-schema discovery from working invoice line access", async () => {
    const { call } = await connect(async () => ({ t0: { name: "SalesOrderDetail", fields: [{ name: "quantity" }, { name: "unitPrice" }] }, t1: null, t2: null, t3: null }));
    const result = await call("get_invoice_line_capabilities");
    expect(result.data.sources[0]).toMatchObject({ hasQuantity: true, hasUnitPrice: true, foundInSchema: true });
    expect(result.data).toMatchObject({ lineReadingImplemented: false, supplierInvoiceLinesVerified: false, documentExtractionImplemented: false });
    expect(result.data.permissionNote).toContain("does not establish");
  });
});
