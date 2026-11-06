import { describe, expect, it, vi } from "vitest";
import { getSalesSettlementDocuments, inspectSalesSettlementCapabilities, publicSettlement, readSalesSettlementDocument } from "../src/settlement-documents.js";
import { extractPdf } from "../src/pdf-reader.js";
import { connection } from "./invoice-fixtures.js";
import { settlementBackend, settlementRequest, settlementPdf } from "./settlement-fixtures.js";

describe("original sales-settlement documents", () => {
  it("discovers original-file paths without claiming permissions or reading business rows", async () => {
    const { run } = settlementBackend();
    expect(await inspectSalesSettlementCapabilities(run)).toMatchObject({ recordReadPermissionsVerified: false,
      primaryFilePath: "transactions.header.invoiceFile", attachmentsPath: "transactions.header.attachments", cashPaymentTotalsImplemented: false });
    expect(run.mock.calls.every(([q]) => q.includes("__type"))).toBe(true);
  });
  it("finds an attachment when the primary file is null, and exposes no signed URL", async () => {
    const { run } = settlementBackend({ attachments: true });
    const result = await getSalesSettlementDocuments(run, settlementRequest);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].sourcePath).toBe("transactions.header.attachments.file");
    const safe = publicSettlement(result);
    expect(safe).toMatchObject({ enumerationComplete: true, paymentAmountVerified: false, customerCashPayments: null });
    expect(JSON.stringify(safe)).not.toContain("signature");
    expect(run.mock.calls.filter(([q]) => q.includes("transactions(")).every(([q]) => q.includes("ownerSet: CURRENT") && q.includes("periodId: 99") && q.includes("headerDbId: 90"))).toBe(true);
  });
  it("deduplicates a file linked both directly and as an attachment", async () => {
    const result = await getSalesSettlementDocuments(settlementBackend({ primary: true, attachments: true }).run, settlementRequest);
    expect(result.documents).toHaveLength(1);
  });
  it("does not turn missing originals into a zero cash amount", async () => {
    const result = publicSettlement(await getSalesSettlementDocuments(settlementBackend().run, settlementRequest));
    expect(result).toMatchObject({ status: "missing_document", customerCashPayments: null, paymentAmountVerified: false });
  });
  it.each([{ headerOwner: 8 }, { rowOwner: 8 }, { docOwner: 8, primary: true }, { wrongPeriod: true }])("refuses wrong owner or accounting period %j", async options => {
    await expect(getSalesSettlementDocuments(settlementBackend(options).run, settlementRequest)).rejects.toThrow(/mismatch|outside/);
  });
  it.each([{ source: "AP" }, { source: "PR" }, { cash: false }, { sales: false }])("blocks unrelated, payroll and bank vouchers %j", async options => {
    const { run } = settlementBackend(options);
    await expect(getSalesSettlementDocuments(run, settlementRequest)).rejects.toThrow("Only posted AR");
    expect(run.mock.calls.some(([q]) => q.includes("__type"))).toBe(false);
  });
  it("does not treat a missing field in an upstream response as null", async () => {
    await expect(getSalesSettlementDocuments(settlementBackend({ missingPrimaryField: true }).run, settlementRequest)).rejects.toThrow("file field is missing");
  });
  it("propagates attachment permission failures rather than declaring complete coverage", async () => {
    await expect(getSalesSettlementDocuments(settlementBackend({ primary: true, failAttachments: true }).run, settlementRequest)).rejects.toThrow("permission denied");
  });
  it("rejects unavailable schema rather than declaring no documents", async () => {
    await expect(getSalesSettlementDocuments(settlementBackend({ types: { TransactionHeader: null } }).run, settlementRequest)).rejects.toThrow("schema is unavailable");
  });
  it("marks unsupported attachment shapes incomplete", async () => {
    const { run } = settlementBackend({ primary: true, types: { JournalAttachment: { name: "JournalAttachment", fields: [] } } });
    const result = await getSalesSettlementDocuments(run, settlementRequest);
    expect(result.enumerationComplete).toBe(false);
    expect(result.documents).toHaveLength(1);
  });
  it("reads every attachment page and safely quotes continuation cursors", async () => {
    const first = { dbId: 1, ownerDbId: 7, headerDbId: 90, file: null };
    const second = { ...first, dbId: 2 };
    const cursor = 'cursor" injected';
    const { run } = settlementBackend({ attachmentPages: [connection("attachments", [first], true, cursor).attachments, connection("attachments", [second]).attachments] });
    const result = await getSalesSettlementDocuments(run, settlementRequest);
    expect(result.enumerationComplete).toBe(true);
    expect(run.mock.calls.some(([q]) => q.includes(`after: ${JSON.stringify(cursor)}`))).toBe(true);
  });
  it("marks a missing continuation incomplete", async () => {
    const c = connection("attachments", [{ dbId: 1, ownerDbId: 7, headerDbId: 90, file: null }], true, "").attachments;
    expect((await getSalesSettlementDocuments(settlementBackend({ attachmentPages: [c] }).run, settlementRequest)).enumerationComplete).toBe(false);
  });
  it("preserves exact header linkage when a schema uses string IDs", async () => {
    const c = connection("attachments", [{ dbId: 1, ownerDbId: 7, headerDbId: "90", file: null }]).attachments;
    const { run, types } = settlementBackend({ attachmentPages: [c] });
    types.JournalAttachment.fields.find((f: any) => f.name === "headerDbId").type.name = "Int64String";
    expect((await getSalesSettlementDocuments(run, settlementRequest)).enumerationComplete).toBe(true);
  });
  it.each([
    { dbId: 1, ownerDbId: 8, headerDbId: 90, file: null },
    { dbId: 1, ownerDbId: 7, headerDbId: 91, file: null },
  ])("refuses a foreign attachment %j", async node => {
    const c = connection("attachments", [node]).attachments;
    await expect(getSalesSettlementDocuments(settlementBackend({ attachmentPages: [c] }).run, settlementRequest)).rejects.toThrow("attachment identity");
  });
  it("does not download an unrelated file supplied by a caller", async () => {
    const settlement = await getSalesSettlementDocuments(settlementBackend({ primary: true }).run, settlementRequest);
    const download = vi.fn();
    await expect(readSalesSettlementDocument(settlement, "999", "https://www.xledger.net/graphql", { download })).rejects.toThrow("not linked");
    expect(download).not.toHaveBeenCalled();
  });
  it("reads an actual daily-report PDF without imposing invoice-number rules or inferring a total", async () => {
    const settlement = await getSalesSettlementDocuments(settlementBackend({ primary: true }).run, settlementRequest);
    const { result, bytes } = await readSalesSettlementDocument(settlement, "100", "https://www.xledger.net/graphql", { download: async () => settlementPdf() });
    expect(result).toMatchObject({ status: "text_read; payment_amount_unverified", pages: 1, pagesRead: 1, documentTextComplete: true,
      paymentAmountVerified: false, customerCashPayments: null, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(bytes).toEqual(settlementPdf());
    expect("paymentEvidence" in result && result.paymentEvidence).toContainEqual(expect.objectContaining({ page: 1, line: 4, text: "Cash payments NOK 500.00" }));
    expect(JSON.stringify(result)).not.toContain("signature");
  });
  it.each(["ocr", "incomplete"])("keeps %s extraction in review", async kind => {
    const settlement = await getSalesSettlementDocuments(settlementBackend({ primary: true }).run, settlementRequest);
    const extracted = await extractPdf(settlementPdf());
    const { result } = await readSalesSettlementDocument(settlement, "100", "https://www.xledger.net/graphql", {
      download: async () => settlementPdf(), pdf: async () => ({ ...extracted, ocrUsed: kind === "ocr", textComplete: kind !== "incomplete" }),
    });
    expect(result).toMatchObject({ status: "needs_review", paymentAmountVerified: false, customerCashPayments: null });
  });
  it("returns explicit failure states for unavailable or unsupported originals", async () => {
    const settlement = await getSalesSettlementDocuments(settlementBackend({ primary: true }).run, settlementRequest);
    const failed = await readSalesSettlementDocument(settlement, "100", "https://www.xledger.net/graphql", { download: async () => { throw new Error("private URL"); } });
    expect(failed.result).toMatchObject({ status: "download_failed", customerCashPayments: null });
    const html = await readSalesSettlementDocument(settlement, "100", "https://www.xledger.net/graphql", { download: async () => Buffer.from("<html>Sign in</html>") });
    expect(html.result).toMatchObject({ status: "unsupported_format", documentTextComplete: false });
    expect(html.bytes).toBeNull();
    expect(JSON.stringify(failed)).not.toContain("private URL");
  });
});
