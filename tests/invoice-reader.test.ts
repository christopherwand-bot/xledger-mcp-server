import { describe, expect, it, vi } from "vitest";
import { readSourceInvoice, checkpointRead } from "../src/invoice-reader.js";
import { invoicePriceHistory, normalizedPrice } from "../src/invoice-prices.js";
import { readEhf } from "../src/ehf-reader.js";
import { ehf, sourceInvoice } from "./invoice-fixtures.js";

const read = (number = "SYN-1", price = "300", net = "600", extra: any = {}) => readSourceInvoice(sourceInvoice({ invoiceNumber: number, ...extra }), "https://demo.xledger.net/graphql", { download: async () => ehf({ number, price, net, date: extra.invoiceDate }) });
describe("document attribution and price history", () => {
  it("returns a hash, actual line and invoice provenance without leaking signed URLs", async () => {
    const { result } = await read();
    expect(result.status).toBe("read"); expect(result.documents[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain("signature=secret");
    expect(checkpointRead(result).documents[0].parsed!.text).toBe("");
    const g = invoicePriceHistory([result]).groups[0];
    expect(g).toMatchObject({ supplierId: "8", unit: "kg", pack: "25 kg/C62", weightedUnitPriceExVat: "12" });
    expect(g.observations[0]).toMatchObject({ documentId: "100", lineId: "001", invoiceNumber: "SYN-1", originalQuantity: "2", unitPriceExVat: "12" });
  });
  it("calculates price changes using fully matching units/packs and exact decimals", async () => {
    const a = (await read()).result;
    const b = (await read("SYN-2", "330", "660", { dbId: "11", invoiceDate: "2026-01-02" })).result;
    const g = invoicePriceHistory([a, b]).groups[0];
    expect(g).toMatchObject({ minUnitPriceExVat: "12", maxUnitPriceExVat: "13.2", changePercent: "10", changeExVat: "1.2", weightedUnitPriceExVat: "12.6" });
  });
  it("keeps other suppliers, currencies and pack sizes in separate groups", async () => {
    const first = (await read()).result;
    const other = structuredClone(first); other.invoice.supplierId = "9";
    const eur = structuredClone(first); eur.documents[0].sha256 = "a".repeat(64); eur.documents[0].parsed!.lines[0].currency = "EUR";
    const pack = structuredClone(first); pack.documents[0].sha256 = "b".repeat(64); pack.documents[0].parsed!.lines[0].description = "Test flour 10 kg";
    expect(invoicePriceHistory([first, other, eur, pack]).groups).toHaveLength(4);
  });
  it("never infers kilograms from ambiguous multipacks or a missing pack weight", () => {
    const line = readEhf(ehf()).lines[0];
    expect(normalizedPrice({ ...line, description: "Flour 2 x 25 kg" }).unit).toBe("C62");
    expect(normalizedPrice({ ...line, description: "Flour approx. 25 kg" }).unit).toBe("C62");
    expect(normalizedPrice({ ...line, description: "Flour 20-25 kg" }).unit).toBe("C62");
    expect(normalizedPrice({ ...line, description: "Flour 25 kg x 2" }).unit).toBe("C62");
    expect(normalizedPrice({ ...line, description: "Flour bag" }).unit).toBe("C62");
    expect(normalizedPrice({ ...line, unit: "GRM", quantity: "500", netAmount: "10" })).toMatchObject({ unit: "kg", price: "20", quantity: "0.5" });
  });
  it("reports missing and failed downloads individually without inventing lines", async () => {
    const empty = await readSourceInvoice(sourceInvoice({ documents: [] }), "https://demo.xledger.net");
    expect(empty.result.status).toBe("missing_document");
    const fail = await readSourceInvoice(sourceInvoice(), "https://demo.xledger.net", { download: async () => { throw new Error("Document download returned HTTP 404"); } });
    expect(fail.result).toMatchObject({ status: "failed", selectedDocumentId: null });
    expect(invoicePriceHistory([empty.result, fail.result]).groups).toEqual([]);
  });
  it("rejects mismatched document identity and does not misread HTML as EHF", async () => {
    const mismatch = await readSourceInvoice(sourceInvoice(), "https://demo.xledger.net", { download: async () => ehf({ number: "OTHER" }) });
    expect(mismatch.result.documents[0].status).toBe("identity_mismatch");
    expect(invoicePriceHistory([mismatch.result]).groups).toEqual([]);
    const html = await readSourceInvoice(sourceInvoice(), "https://demo.xledger.net", { download: async () => Buffer.from("<html>Sign in</html>") });
    expect(html.result.documents[0].status).toBe("unsupported_format");
  });
  it("does not double-count the same original, and excludes credits and OCR values", async () => {
    const a = (await read()).result;
    expect(invoicePriceHistory([a, structuredClone(a)]).groups[0].observationCount).toBe(1);
    const credit = await readSourceInvoice(sourceInvoice(), "https://demo.xledger.net", { download: async () => ehf({ credit: true }) });
    expect(invoicePriceHistory([credit.result]).groups).toHaveLength(0);
    const ocr = structuredClone(a); ocr.documents[0].parsed!.lines[0].confidence = "ocr_review";
    expect(invoicePriceHistory([ocr]).groups).toHaveLength(0);
  });
  it("does not pretend an unnumbered AP payment is a product invoice", async () => {
    const download = vi.fn();
    const result = await readSourceInvoice(sourceInvoice({ invoiceNumber: null }), "https://demo.xledger.net", { download });
    expect(result.result.status).toBe("not_numbered"); expect(download).not.toHaveBeenCalled();
  });
  it("flags conflicting PDF/EHF originals instead of silently choosing their prices", async () => {
    const invoice = sourceInvoice();
    invoice.documents.push({ ...invoice.documents[0], dbId: "101", fileName: "copy.pdf", url: "https://demo.xledger.net/copy.pdf" });
    const conflict = { ...readEhf(ehf({ price: "310", net: "620" })), format: "pdf" as const };
    const { result } = await readSourceInvoice(invoice, "https://demo.xledger.net", { download: async url => url.endsWith(".pdf") ? Buffer.from("%PDF-synthetic") : ehf(), pdf: async () => conflict });
    expect(result.status).toBe("needs_review");
    expect(result.warnings.join(" ")).toContain("disagree");
    expect(invoicePriceHistory([result]).groups).toHaveLength(0);
  });
});
