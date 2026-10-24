import { describe, expect, it, vi } from "vitest";
import { currentInvoiceEntity, getSourceInvoice, listSourceInvoices, publicInvoice } from "../src/invoice-source.js";

import { apiNode, connection } from "./invoice-fixtures.js";

describe("Xledger original invoice paths", () => {
  it("finds the transaction-header document when the AP invoiceFile is null", async () => {
    const run = vi.fn(async (query: string) => query.includes("entities(") ? { entities: { edges: [{ node: { dbId: 7 } }] } } : connection("apTransactions", [apiNode()]));
    const invoice = await getSourceInvoice(run, "apTransactions", "10");
    expect(invoice.documents[0]).toMatchObject({ sourcePath: "apTransactions.transactionHeader.invoiceFile", dbId: "110" });
    expect(run.mock.calls[1][0]).toContain("ownerSet: CURRENT, filter: { ownerDbId: 7, dbId: 10 }");
    expect(JSON.stringify(publicInvoice(invoice))).not.toContain("signature=private");
  });
  it("deduplicates the same document linked from both invoice and header", async () => {
    const n = apiNode(); n.invoiceFile = n.transactionHeader.invoiceFile;
    const page = await listSourceInvoices(async () => connection("apTransactions", [n]), { source: "apTransactions", owner: 7 });
    expect(page.rows[0].documents).toHaveLength(1);
  });
  it.each([
    apiNode(10, { ownerDbId: 8 }),
    apiNode(10, { transactionHeader: { dbId: 100, ownerDbId: 9, invoiceFile: null } }),
    apiNode(10, { transactionHeader: { dbId: 100, ownerDbId: 7, invoiceFile: { dbId: "110", ownerDbId: 8, url: "https://demo.xledger.net/doc" } } }),
  ])("refuses cross-entity invoice/header/document records", async node => {
    await expect(listSourceInvoices(async () => connection("apTransactions", [node]), { source: "apTransactions", owner: 7 })).rejects.toThrow(/owner|identity/i);
  });
  it("keeps AP and vendor source IDs distinct and uses the actual supplier filter", async () => {
    const run = vi.fn(async () => connection("vendorInvoices", [apiNode()]));
    await listSourceInvoices(run, { source: "vendorInvoices", owner: 7, supplierId: "8", fromDate: "2026-01-01", toDate: "2026-01-31", after: 'a"b' });
    const q = run.mock.calls[0][0]; expect(q).toContain("supplierDbId: 8"); expect(q).not.toContain("subledgerDbId"); expect(q).toContain('after: "a\\"b"');
  });
  it("rejects an incomplete page or nonadvancing cursor", async () => {
    await expect(listSourceInvoices(async () => ({ apTransactions: { edges: [] } }), { source: "apTransactions", owner: 7 })).rejects.toThrow("incomplete");
    await expect(listSourceInvoices(async () => connection("apTransactions", [apiNode()], true, "same"), { source: "apTransactions", owner: 7, after: "same" })).rejects.toThrow("continuation");
  });
  it("requires a single verified current entity", async () => {
    await expect(currentInvoiceEntity(async () => ({ entities: { edges: [] } }))).rejects.toThrow("Exactly one");
    await expect(currentInvoiceEntity(async () => ({ entities: { edges: [{ node: { dbId: 7 } }, { node: { dbId: 8 } }] } }))).rejects.toThrow("Exactly one");
  });
  it("validates dates and IDs before issuing a financial query", async () => {
    const run = vi.fn();
    await expect(listSourceInvoices(run, { source: "apTransactions", owner: 7, fromDate: "2026-02-30" })).rejects.toThrow();
    await expect(listSourceInvoices(run, { source: "apTransactions", owner: 7, dbId: '10} mutation{' })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
