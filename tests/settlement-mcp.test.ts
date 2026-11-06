import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server.js";
import { CompanyRegistry } from "../src/companies.js";
import * as downloads from "../src/invoice-download.js";
import { connection } from "./invoice-fixtures.js";
import { settlementBackend, settlementRequest, settlementPdf } from "./settlement-fixtures.js";

const sessions: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function connect() {
  vi.stubEnv("XLEDGER_ENABLE_PERSONNEL_TOOLS", "");
  const backend = settlementBackend({ attachments: true });
  const registry = new CompanyRegistry({ XLEDGER_GRAPHQL_TOKEN: "synthetic-only", XLEDGER_API_URL: "https://www.xledger.net/graphql" }, () => async query => {
    if (query.includes("entities(")) return connection("entities", [{ dbId: 7, description: "Kraftgutta AS" }]);
    return backend.run(query);
  });
  const server = createMcpServer(undefined, registry), client = new Client({ name: "settlement-protocol-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); sessions.push(client, server);
  return { client, backend };
}
describe("sales settlement documents through MCP", () => {
  it("registers read-only company-scoped tools and returns the exact original PDF with its company URI", async () => {
    vi.spyOn(downloads, "downloadInvoiceDocument").mockResolvedValue(settlementPdf());
    const { client } = await connect();
    const names = ["get_sales_settlement_capabilities", "get_sales_settlement_documents", "read_sales_settlement_document"];
    for (const name of names) {
      const t = (await client.listTools()).tools.find(t => t.name === name);
      expect(t?.annotations?.readOnlyHint).toBe(true); expect(t?.inputSchema.properties?.company).toBeDefined();
    }
    const response = await client.callTool({ name: "read_sales_settlement_document", arguments: {
      ...settlementRequest, company: "kraftgutta", documentId: "100", includeFile: true,
    } });
    expect(response.isError).not.toBe(true);
    const content = response.content as any[], data = JSON.parse(content.find(c => c.type === "text").text);
    expect(data).toMatchObject({ company: { id: "kraftgutta", ownerDbId: 7 }, paymentAmountVerified: false, customerCashPayments: null });
    expect(data.text).toContain("Cash payments NOK 500.00");
    const resource = content.find(c => c.type === "resource").resource;
    expect(resource.uri).toBe("xledger://companies/kraftgutta/settlements/90/documents/100");
    expect(Buffer.from(resource.blob, "base64")).toEqual(settlementPdf());
    expect(JSON.stringify(data)).not.toContain("signature");
  });
  it("pages full text explicitly without changing document-read coverage or certifying payments", async () => {
    vi.spyOn(downloads, "downloadInvoiceDocument").mockResolvedValue(settlementPdf());
    const { client } = await connect();
    const result = await client.callTool({ name: "read_sales_settlement_document", arguments: {
      ...settlementRequest, company: "kraftgutta", documentId: "100", textOffset: 20, maxTextCharacters: 1000,
    } });
    const data = JSON.parse((result.content as any[]).find(c => c.type === "text").text);
    expect(data).toMatchObject({ documentTextComplete: true, textOutputTruncated: true, nextTextOffset: null, paymentAmountVerified: false });
    expect(data.text.startsWith("[Page")).toBe(false);
  });
  it("rejects a voucher-number injection before company or data reads", async () => {
    const { client, backend } = await connect();
    const result = await client.callTool({ name: "get_sales_settlement_documents", arguments: { ...settlementRequest, headerDbId: '90) mutation {' } });
    expect(result.isError).toBe(true); expect(backend.run).not.toHaveBeenCalled();
  });
});
