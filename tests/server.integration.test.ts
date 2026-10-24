import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import type { GqlRunner } from "../src/graphql.js";
import { apiNode, syntheticPdf } from "./invoice-fixtures.js";
import * as invoiceDownload from "../src/invoice-download.js";

const sessions: Array<{ close: () => Promise<void> }> = [];
beforeEach(() => vi.stubEnv("XLEDGER_ENABLE_PERSONNEL_TOOLS", ""));
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
  it("returns the actual original PDF as an embedded resource through MCP", async () => {
    vi.spyOn(invoiceDownload, "downloadInvoiceDocument").mockResolvedValue(syntheticPdf());
    const run = vi.fn(async (query: string) => query.includes("entities(") ? page("entities", [{ dbId: 7 }]) : page("apTransactions", [apiNode(10, { invoiceNumber: "SYN-1" })]));
    const { client } = await connect(run);
    const result = await client.callTool({ name: "read_invoice_document", arguments: { invoiceDbId: "10", includeFile: true } });
    expect(result.isError).not.toBe(true);
    const content = result.content as any[];
    expect(JSON.parse(content.find(c => c.type === "text").text).status).toBe("read");
    const resource = content.find(c => c.type === "resource").resource;
    expect(resource.mimeType).toBe("application/pdf");
    expect(resource.uri).toBe("xledger://invoices/apTransactions/10/documents/110");
    expect(Buffer.from(resource.blob, "base64")).toEqual(syntheticPdf());
  });
  it("finds an exact invoice's transaction-header original through the MCP tool", async () => {
    const run = vi.fn(async (query: string) => query.includes("entities(") ? page("entities", [{ dbId: 7 }]) : page("apTransactions", [apiNode(10)]));
    const { client, call } = await connect(run);
    const result = await call("get_invoice_documents", { invoiceDbId: "10" });
    expect(result.error).toBe(false);
    expect(result.data.invoice.documents[0]).toMatchObject({ dbId: "110", sourcePath: "apTransactions.transactionHeader.invoiceFile" });
    expect(JSON.stringify(result.data)).not.toContain("signature");
    const { tools } = await client.listTools();
    for (const name of ["read_invoice_document", "start_invoice_scan", "get_invoice_scan", "resume_invoice_scan", "get_item_price_history"]) {
      expect(tools.find(t => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
  });
  it("returns BOTH negative supplier invoices and positive credit balances as open items", async () => {
    const input = [
      { dbId: 1, invoiceNumber: "TEST-INVOICE", invoiceRemaining: "-100.0000" },
      { dbId: 2, invoiceNumber: "TEST-CREDIT", invoiceRemaining: "25.0000" },
      { dbId: 3, invoiceNumber: "TEST-PAID", invoiceRemaining: "0.0000" },
    ].map(row => ({ ...row, ownerDbId: 7, transactionHeaderDbId: 70, transactionHeader: { dbId: 70, ownerDbId: 7 } }));
    const run = vi.fn(async (query: string) => query.includes("entities(") ? page("entities", [{ dbId: 7 }]) : page("apTransactions", input.filter(row => {
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
    ["get_invoice_line_records", { source: "journalEntries" }],
    ["get_invoice_line_records", { source: "eInvoiceDetails", first: 51 }],
    ["get_invoice_line_records", { source: "eInvoiceDetails", includeReferences: "yes" }],
    ["get_invoice_documents", { invoiceDbId: '1} mutation{' }],
    ["read_invoice_document", { invoiceDbId: "10", source: "eInvoices" }],
    ["start_invoice_scan", { fromDate: "2026-02-30", toDate: "2026-03-01" }],
    ["get_invoice_scan", { scanId: "../../etc/passwd" }],
    ["get_item_price_history", { scanId: "invalid" }],
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

  it.each([
    ["get_journal_entries", "journalEntries"],
    ["get_cash_transactions", "cashBookTransactions"],
  ])("uses Xledger's offset-free timestamps and includes the final second in %s", async (name, root) => {
    const records = [
      { dbId: 1, fiscalYear: 2026, createdAt: "2026-04-30T23:59:59.500" },
      { dbId: 2, fiscalYear: 2026, createdAt: "2026-05-01T00:00:00.000" },
    ];
    const run = vi.fn(async query => {
      const from = /createdAt_gte:\s*"([^"]+)"/.exec(query)![1];
      const to = /createdAt_lte:\s*"([^"]+)"/.exec(query)![1];
      // Contract observed from Xledger: these scalar arguments reject offsets.
      const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?$/;
      if (!valid.test(from) || !valid.test(to)) throw new Error("Bad format for createdAt: time-zone suffix is not supported");
      return page(root, records.filter(row => row.createdAt >= from && row.createdAt <= to));
    });
    const { call } = await connect(run);
    const result = await call(name, { first: 5, fromDate: "2026-04-01", toDate: "2026-04-30" });
    expect(result.error).toBe(false);
    expect(result.data.items.map((row: any) => row.dbId)).toEqual([1]);
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
    expect(names).toContain("get_invoice_line_records");
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
    expect(result.data).toMatchObject({ lineReadingImplemented: true, supplierInvoiceLinesVerified: false, documentExtractionImplemented: true });
    expect(result.data.permissionNote).toContain("does not establish");
  });

  it("reads a minimal structured invoice record through the registered MCP tool", async () => {
    const run = vi.fn(async (query: string) => {
      const scalar = (name: string, type: string) => ({ name, type: { kind: "SCALAR", name: type } });
      if (query.includes("__schema")) return {
        __schema: { queryType: { fields: [{ name: "eInvoiceDetails", type: { kind: "OBJECT", name: "EInvoiceDetailConnection" },
          args: [scalar("first", "Int"), scalar("after", "String"), scalar("ownerSet", "OwnerSet")] }] } },
        n0: { fields: [scalar("dbId", "Int64String"), scalar("quantity", "Float"), scalar("unitPrice", "MoneyString")] },
      };
      expect(query).toContain("first: 1, ownerSet: CURRENT");
      return page("eInvoiceDetails", [{ dbId: "100", quantity: -2.5, unitPrice: "12.3400" }]);
    });
    const { call } = await connect(run);
    const result = await call("get_invoice_line_records", { source: "eInvoiceDetails" });
    expect(result.error).toBe(false);
    expect(result.data.items).toEqual([{ dbId: "100", quantity: -2.5, unitPrice: "12.3400" }]);
    expect(result.data).toMatchObject({ originalSupplierProductLinesVerified: false, normalizedUnitPrice: null, referencesIncluded: false });
  });


  it("discovers a schema path to line types without reading business records", async () => {
    const run = vi.fn(async (query: string) => {
      if (query.includes("__schema")) return {
        __schema: { queryType: { fields: [
          { name: "invoiceBaseItems", args: [{ name: "first", type: { kind: "SCALAR", name: "Int" } }], type: { kind: "OBJECT", name: "InvoiceBaseItemConnection" } },
          { name: "customers", args: [], type: { kind: "OBJECT", name: "CustomerConnection" } },
        ] } },
      };
      if (query.includes('InvoiceBaseItemConnection')) return { t0: { name: "InvoiceBaseItemConnection", fields: [{ name: "edges", type: { kind: "LIST", ofType: { kind: "OBJECT", name: "InvoiceBaseItemEdge" } } }] } };
      if (query.includes('InvoiceBaseItemEdge')) return { t0: { name: "InvoiceBaseItemEdge", fields: [{ name: "node", type: { kind: "OBJECT", name: "InvoiceBaseItem" } }] } };
      throw new Error(`Unexpected query: ${query}`);
    });
    const { call } = await connect(run);
    const result = await call("discover_invoice_line_read_paths");
    expect(result.error).toBe(false);
    expect(result.data.paths).toContainEqual(expect.objectContaining({
      rootField: "invoiceBaseItems",
      leadsToKnownLineType: true,
      connectionShape: expect.objectContaining({ nodeType: "InvoiceBaseItem" }),
    }));
    expect(result.data.recordReadingImplemented).toBe(false);
    expect(result.data.permissionNote).toContain("does not prove");
  });
});
