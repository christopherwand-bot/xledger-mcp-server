import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { CompanyRegistry } from "../src/companies.js";
import { OnlinePosRegistry } from "../src/onlinepos.js";

const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const range = { from: "2026-10-01T00:00:00+02:00", to: "2026-10-02T00:00:00+02:00" };
async function connect(posOptions: Record<string, string> = {}) {
  vi.stubEnv("XLEDGER_ENABLE_PERSONNEL_TOOLS", "");
  const xledger = new CompanyRegistry({ XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA_HONEFOSS: "synthetic-x-h", XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA_KONGSBERG: "synthetic-x-k" }, ({ token }) => async query => {
    if (!query.includes("entities(")) throw Error("No Xledger finance read is needed for an OnlinePOS call");
    return { entities: { edges: [{ node: { dbId: token.endsWith("h") ? 7 : 8,
      description: token.endsWith("h") ? "Kraft Pizzeria Hønefoss AS" : "Kraft Pizzeria Kongsberg AS" } }] } };
  });
  const configs = [{ restaurantId: "honefoss", firmaid: 1001, token: "synthetic-provider-h", companyName: "Synthetic North" },
    { restaurantId: "kongsberg", firmaid: 1002, token: "synthetic-provider-k", companyName: "Synthetic South" }];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const id = Number((init?.headers as any).firmaid);
    return new Response(JSON.stringify(String(input).includes("koncernInfo")
      ? { lokations: [{ firmaid: id, name: "Synthetic location", city: "Test City", departments: [] }] }
      : String(input).includes("end_of_day_journal") ? { journal_entries: configs.map(c => ({ venue_id: c.firmaid, cash_register_id: 1,
        journal_number: 2, time: "2026-10-01T21:00:00+02:00", journal_lines: [
          { journal_line_text: "2 - Revenue", journal_line_account_number: "3000", journal_line_amount: "25", journal_line_type: "credit" },
          { journal_line_text: "2 - Startoptælling", journal_line_account_number: "1905", journal_line_amount: "10", journal_line_type: "credit" },
          { journal_line_text: "2 - Slutoptælling", journal_line_account_number: "1905", journal_line_amount: "35", journal_line_type: "debit" },
        ] })) } : { entries: configs.map(c => ({ entry: { firmaid: c.firmaid, departmentid: 1, booknumber: 2, revenue: "100",
          enddate: String(Date.parse("2026-10-01T21:00:00+02:00") / 1000), btypes: { Kontant: "25" } } })) }));
  });
  const pos = new OnlinePosRegistry({ ONLINEPOS_ENABLED: "true", ONLINEPOS_COMPANIES: JSON.stringify(configs), ONLINEPOS_SYNC_INTERVAL_MS: "0", ...posOptions }, fetcher);
  const server = createMcpServer(undefined, xledger, pos), client = new Client({ name: "onlinepos-protocol-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); sessions.push(client, server);
  return { client, fetcher };
}
describe("OnlinePOS through the actual MCP protocol", () => {
  it("registers company-scoped read-only tools", async () => {
    const { client } = await connect();
    for (const name of ["get_onlinepos_connection_info", "get_onlinepos_revenue_journals", "get_onlinepos_end_of_day_journals", "get_onlinepos_cash_analysis"]) {
      const tool = (await client.listTools()).tools.find(t => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(true); expect(tool?.inputSchema.properties?.company).toBeDefined();
    }
  });
  it("requires an explicit company before any OnlinePOS network request", async () => {
    const { client, fetcher } = await connect();
    const result = await client.callTool({ name: "get_onlinepos_revenue_journals", arguments: range });
    expect(result.isError).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves both companies across overlapping calls and never returns another venue's rows", async () => {
    const { client } = await connect();
    const companies = ["kraft_pizzeria_honefoss", "kraft_pizzeria_kongsberg"];
    const results = await Promise.all(companies.map(company => client.callTool({ name: "get_onlinepos_revenue_journals", arguments: { company, ...range } })));
    for (const [i, result] of results.entries()) {
      expect(result.isError).not.toBe(true);
      const data = JSON.parse((result.content as any[]).find(c => c.type === "text").text);
      expect(data).toMatchObject({ company: { id: companies[i], ownerDbId: i ? 8 : 7 }, source: "onlinepos", firmaid: i ? 1002 : 1001,
        items: [{ firmaid: i ? 1002 : 1001 }], paymentAmountVerified: false, customerCashPayments: null });
      expect(data.items).toHaveLength(1); expect(JSON.stringify(data)).not.toContain("synthetic-provider-");
    }
  });
  it("keeps a disabled integration available for configuration inspection without provider traffic", async () => {
    const { client, fetcher } = await connect({ ONLINEPOS_ENABLED: "false" });
    const result = await client.callTool({ name: "get_onlinepos_connection_info", arguments: { company: "kraft_pizzeria_kongsberg", checkReadAccess: true } });
    const data = JSON.parse((result.content as any[]).find(c => c.type === "text").text);
    expect(data).toMatchObject({ source: "onlinepos", enabled: false, configured: true, location: null });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("requires an explicit company before cash-analysis traffic and returns no false zero", async () => {
    const { client, fetcher } = await connect();
    const result = await client.callTool({ name: "get_onlinepos_cash_analysis", arguments: { from: "2026-10-01T18:00:00+02:00", to: "2026-10-01T23:00:00+02:00" } });
    expect(result.isError).toBe(true); expect(fetcher).not.toHaveBeenCalled();
  });
  it("compares both source endpoints through MCP while keeping simultaneous restaurant analyses isolated", async () => {
    const { client } = await connect();
    const companies = ["kraft_pizzeria_honefoss", "kraft_pizzeria_kongsberg"];
    const results = await Promise.all(companies.map(company => client.callTool({ name: "get_onlinepos_cash_analysis", arguments: {
      company, from: "2026-10-01T18:00:00+02:00", to: "2026-10-01T23:00:00+02:00" } })));
    for (const [i, result] of results.entries()) {
      expect(result.isError).not.toBe(true);
      const data = JSON.parse((result.content as any[]).find(c => c.type === "text").text);
      expect(data).toMatchObject({ firmaid: i ? 1002 : 1001, company: { id: companies[i] }, reportedCashFieldSubtotal: "25",
        coverage: { matchedJournals: 1, cashFieldsObserved: 1 }, items: [{ journalBalanceDifference: "0", reportedCash: "25" }],
        customerCashPayments: null, paymentAmountVerified: false });
      expect(data.items).toHaveLength(1); expect(JSON.stringify(data)).not.toContain("synthetic-provider-");
    }
  });
});
