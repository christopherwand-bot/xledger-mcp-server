import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyRegistry } from "../src/companies.js";
import { createMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { sharedInvoiceScans, type InvoiceScans } from "../src/invoice-scans.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiNode, ehf } from "./invoice-fixtures.js";
import * as downloads from "../src/invoice-download.js";

const sessions: Array<{ close(): Promise<void> }> = [];
const folders: string[] = [];
const managers = new Set<InvoiceScans>();
afterEach(async () => {
  for (const manager of managers) await manager.waitForIdle();
  managers.clear();
  for (const session of sessions.splice(0)) await session.close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
const page = (root: string, nodes: any[]) => ({ [root]: { pageInfo: { hasNextPage: false }, edges: nodes.map(node => ({ node, cursor: String(node.dbId) })) } });
function fixture(options: { onlyRestaurant?: boolean; wrongName?: boolean; wrongOwner?: boolean; missingOwner?: boolean; failIdentity?: boolean } = {}) {
  const env = { XLEDGER_API_URL: "https://demo.xledger.net/graphql", XLEDGER_GRAPHQL_TOKEN: options.onlyRestaurant ? "" : "dummy-a",
    XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA: "dummy-b" };
  const calls = new Map<string, ReturnType<typeof vi.fn>>();
  const registry = new CompanyRegistry(env, ({ token }) => {
    const owner = token === "dummy-a" ? 7 : 8;
    const run = vi.fn(async (query: string) => {
      // Deliberately overlap requests to expose mutable/global routing mistakes.
      await new Promise(resolve => setTimeout(resolve, token === "dummy-a" ? 3 : 1));
      if (query.includes("entities(")) {
        if (options.failIdentity) throw new Error("Synthetic identity permission failure");
        return page("entities", [{ dbId: owner, description: owner === 7 ? "Kraftgutta As" : options.wrongName ? "Wrong company AS" : "Kraft Pizzeria AS" }]);
      }
      const rowOwner = options.wrongOwner ? 999 : owner;
      if (query.includes("accountBalances(")) {
        const row: any = { dbId: 1, ownerDbId: rowOwner, fiscalYear: 2026, periodNumber: 10, amount: owner === 7 ? "10.0000" : "20.0000", account: { code: "4300" } };
        if (options.missingOwner) delete row.ownerDbId;
        return page("accountBalances", [row]);
      }
      const node = apiNode(10, { invoiceNumber: "SYN-1", ownerDbId: rowOwner });
      node.transactionHeader.ownerDbId = rowOwner;
      node.transactionHeader.invoiceFile.ownerDbId = rowOwner;
      return page("apTransactions", [node]);
    });
    calls.set(token, run); return run;
  });
  return { registry, calls };
}
async function connect(registry: CompanyRegistry) {
  const server = createMcpServer(undefined, registry);
  const client = new Client({ name: "company-isolation-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); sessions.push(client, server);
  return { client, call: async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as any[]).find(c => c.type === "text")?.text || "";
    return { error: Boolean(result.isError), data: result.isError ? text : JSON.parse(text) };
  } };
}

describe("company registry", () => {
  it("maps exactly the documented five keys without exposing credentials", () => {
    const env = { XLEDGER_GRAPHQL_TOKEN: "dummy-a", XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA: "dummy-b",
      XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA_HONEFOSS: "dummy-c", XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA_KONGSBERG: "dummy-d", XLEDGER_GRAPHQL_TOKEN_SPETI: "dummy-e" };
    const registry = new CompanyRegistry(env, () => vi.fn());
    expect(registry.list().filter(c => c.configured).map(c => c.id)).toEqual(["kraftgutta", "kraft_pizzeria", "kraft_pizzeria_honefoss", "kraft_pizzeria_kongsberg", "speti"]);
    expect(JSON.stringify(registry.list())).not.toMatch(/dummy-|GRAPHQL_TOKEN/);
  });
  it("preserves a single company's default and requires a choice with two", () => {
    expect(fixture({ onlyRestaurant: true }).registry.resolve()).toBe("kraft_pizzeria");
    expect(() => fixture().registry.resolve()).toThrow("explicitly");
  });
  it.each(["missing", "speti", "../kraftgutta", ""])("rejects an invalid/unconfigured selection %j", id => {
    expect(() => fixture().registry.resolve(id)).toThrow();
  });
  it("checks the token's actual CURRENT identity before any accounting read", async () => {
    const { registry, calls } = fixture({ wrongName: true });
    await expect(registry.verify("kraft_pizzeria")).rejects.toThrow("does not match");
    expect(calls.get("dummy-b")!.mock.calls.every(([q]) => q.includes("entities("))).toBe(true);
    expect(calls.get("dummy-a")).not.toHaveBeenCalled();
  });
  it("does not cache a failed identity check as a working company", async () => {
    const { registry, calls } = fixture({ failIdentity: true });
    await expect(registry.verify("kraft_pizzeria")).rejects.toThrow("permission");
    await expect(registry.verify("kraft_pizzeria")).rejects.toThrow("permission");
    expect(calls.get("dummy-b")).toHaveBeenCalledTimes(2);
  });
  it("reuses each company's immutable client and identity across sessions", async () => {
    const { registry, calls } = fixture();
    const [a, b] = await Promise.all([registry.verify("kraftgutta"), registry.verify("kraftgutta")]);
    expect(a).toBe(b); expect(a.run).toBe(b.run);
    expect(calls.get("dummy-a")).toHaveBeenCalledTimes(1);
  });
  it("does not turn a missing financial source into a verified empty company", async () => {
    const registry = new CompanyRegistry({ XLEDGER_GRAPHQL_TOKEN: "dummy-a" }, () => async query =>
      query.includes("entities(") ? page("entities", [{ dbId: 7, description: "Kraftgutta AS" }]) : {});
    const context = await registry.verify("kraftgutta");
    await expect(context.run("{ accountBalances(first: 1) { edges { node { ownerDbId } } } }")).rejects.toThrow("Missing accountBalances");
  });
  it.each([{ wrongOwner: true }, { missingOwner: true }])("blocks cross-company and unverifiable rows %j", async options => {
    const context = await fixture(options).registry.verify("kraft_pizzeria");
    await expect(context.run("{ accountBalances(first: 1) { edges { node { ownerDbId } } } }")).rejects.toThrow("ownership mismatch");
  });
  it("reports every configured identity and marks missing keys explicitly", async () => {
    const result = await fixture({ wrongName: true }).registry.inspect();
    expect(result[0]).toMatchObject({ id: "kraftgutta", status: "verified", ownerDbId: 7 });
    expect(result[1]).toMatchObject({ id: "kraft_pizzeria", status: "failed", identityVerified: false });
    expect(result[4]).toMatchObject({ id: "speti", status: "not_configured" });
  });
});

describe("explicit company routing through the actual MCP protocol", () => {
  it("lists company choices without reading business records or exposing tokens", async () => {
    const { registry, calls } = fixture(); const { call } = await connect(registry);
    const result = await call("list_companies");
    expect(result.data.companySelectionRequired).toBe(true);
    expect(result.data.companies).toHaveLength(5);
    expect(JSON.stringify(result.data)).not.toContain("dummy-");
    expect([...calls.values()].every(run => run.mock.calls.length === 0)).toBe(true);
  });
  it("adds a company argument to every business tool and preserves read-only annotations", async () => {
    const { client } = await connect(fixture().registry);
    for (const tool of (await client.listTools()).tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      if (tool.name !== "list_companies") expect(tool.inputSchema.properties?.company).toBeDefined();
    }
  });
  it("refuses an omitted company before touching either company's accounting", async () => {
    const { registry, calls } = fixture(); const { call } = await connect(registry);
    expect((await call("get_account_balances", { fiscalYear: 2026 })).error).toBe(true);
    expect([...calls.values()].every(run => run.mock.calls.length === 0)).toBe(true);
  });
  it("rejects invalid arguments before company verification or financial reads", async () => {
    const { registry, calls } = fixture(); const { call } = await connect(registry);
    expect((await call("get_account_balances", { company: "kraft_pizzeria", periodNumber: 13 })).error).toBe(true);
    expect([...calls.values()].every(run => run.mock.calls.length === 0)).toBe(true);
  });
  it("reports all company identities when connection info has no selected company", async () => {
    const { call } = await connect(fixture().registry);
    const result = await call("get_connection_info");
    expect(result.data).toMatchObject({ version: "1.8.0", companySelectionRequired: true, currentEntities: [] });
    expect(result.data.companies[1]).toMatchObject({ id: "kraft_pizzeria", status: "verified", ownerDbId: 8 });
  });
  it("probes company-specific read access without returning amounts or invoices", async () => {
    const { call } = await connect(fixture().registry);
    const result = await call("get_connection_info", { company: "kraft_pizzeria", checkReadAccess: true });
    expect(result.data.readAccess).toMatchObject({ accountBalances: { status: "readable", recordOwnershipVerified: true }, apTransactions: { status: "readable", recordOwnershipVerified: true } });
    expect(JSON.stringify(result.data)).not.toMatch(/20\.0000|SYN-1|dummy-/);
  });
  it("keeps empty read-access probes distinct from verified financial zeros", async () => {
    const registry = new CompanyRegistry({ XLEDGER_GRAPHQL_TOKEN: "dummy-a" }, () => async query =>
      query.includes("entities(") ? page("entities", [{ dbId: 7, description: "Kraftgutta AS" }]) : page(query.includes("accountBalances(") ? "accountBalances" : "apTransactions", []));
    expect(await registry.probe("kraftgutta")).toMatchObject({ accountBalances: { status: "accepted_without_rows", recordOwnershipVerified: false }, apTransactions: { status: "accepted_without_rows", recordOwnershipVerified: false } });
  });
  it("keeps overlapping requests to different companies separate in one session", async () => {
    const { registry, calls } = fixture(); const { call } = await connect(registry);
    const [a, b] = await Promise.all([
      call("get_account_balances", { company: "kraftgutta", fiscalYear: 2026, periodNumber: 10 }),
      call("get_account_balances", { company: "kraft_pizzeria", fiscalYear: 2026, periodNumber: 10 }),
    ]);
    expect(a.error).toBe(false); expect(b.error).toBe(false);
    expect(a.data).toMatchObject({ company: { id: "kraftgutta", ownerDbId: 7 }, items: [{ amount: "10.0000", ownerDbId: 7 }] });
    expect(b.data).toMatchObject({ company: { id: "kraft_pizzeria", ownerDbId: 8 }, items: [{ amount: "20.0000", ownerDbId: 8 }] });
    for (const run of calls.values()) expect(run.mock.calls.filter(([q]) => q.includes("accountBalances(")).every(([q]) => q.includes("ownerSet: CURRENT") && q.includes("ownerDbId"))).toBe(true);
  });
  it("does not return cross-company accounting rows", async () => {
    const { call } = await connect(fixture({ wrongOwner: true }).registry);
    const result = await call("get_account_balances", { company: "kraft_pizzeria", fiscalYear: 2026 });
    expect(result.error).toBe(true); expect(result.data).toContain("ownership mismatch");
    expect(result.data).not.toContain("20.0000");
  });
  it("preserves the single configured company's existing calls", async () => {
    const { call } = await connect(fixture({ onlyRestaurant: true }).registry);
    expect((await call("get_account_balances", { fiscalYear: 2026 })).data.company.id).toBe("kraft_pizzeria");
  });
  it("namespaces embedded originals by company even when invoice/document IDs coincide", async () => {
    vi.spyOn(downloads, "downloadInvoiceDocument").mockResolvedValue(ehf());
    const { client } = await connect(fixture().registry);
    const results = await Promise.all(["kraftgutta", "kraft_pizzeria"].map(company => client.callTool({ name: "read_invoice_document", arguments: { company, invoiceDbId: "10", includeFile: true } })));
    results.forEach((result, index) => {
      expect(result.isError).not.toBe(true);
      const resource = (result.content as any[]).find(c => c.type === "resource")?.resource;
      expect(resource.uri).toBe(`xledger://companies/${index ? "kraft_pizzeria" : "kraftgutta"}/invoices/apTransactions/10/documents/110`);
    });
  });
  it("retains a scan's company in background work and blocks another company from polling it", async () => {
    const root = await mkdtemp(join(tmpdir(), "company-scan-test-")); folders.push(root); vi.stubEnv("XLEDGER_INVOICE_SCAN_DIR", root);
    vi.spyOn(downloads, "downloadInvoiceDocument").mockResolvedValue(ehf());
    const { registry } = fixture(); const { call } = await connect(registry);
    const a = await registry.verify("kraftgutta"), b = await registry.verify("kraft_pizzeria");
    const manager = sharedInvoiceScans(a.run, registry.url); managers.add(manager);
    expect(sharedInvoiceScans(a.run, registry.url)).toBe(manager);
    expect(sharedInvoiceScans(b.run, registry.url)).not.toBe(manager);
    const started = await call("start_invoice_scan", { company: "kraftgutta", fromDate: "2026-01-01", toDate: "2026-01-31", includeUnposted: false });
    expect(started.error).toBe(false);
    await call("get_connection_info", { company: "kraft_pizzeria" });
    await manager.waitForIdle();
    const read = await call("get_invoice_scan", { company: "kraftgutta", scanId: started.data.scanId });
    expect(read.data.coverage.allInvoicesRead, JSON.stringify(read.data)).toBe(true);
    expect(read.data.company.id).toBe("kraftgutta");
    expect((await call("get_invoice_scan", { company: "kraft_pizzeria", scanId: started.data.scanId })).error).toBe(true);
  });
});
