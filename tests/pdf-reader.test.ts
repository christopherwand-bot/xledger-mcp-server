import { describe, expect, it } from "vitest";
import { readPdf } from "../src/pdf-reader.js";
import { syntheticPdf } from "./invoice-fixtures.js";
import { readFile } from "node:fs/promises";

describe("native PDF extraction", () => {
  it("reads a real generated PDF and uses delivered quantity, not ordered quantity", async () => {
    const result = await readPdf(syntheticPdf(), "NOK");
    expect(result).toMatchObject({ format: "pdf", invoiceNumber: "SYN-1", invoiceDate: "2026-01-01", pages: 1, pagesRead: 1, status: "read", lineNetTotal: "600" });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ quantity: "2", unit: "C62", price: "300", netAmount: "600", confidence: "reconciled_pdf", page: 1 });
    expect(result.text).toContain("Test flour 25 kg");
  });
  it("flags a different document currency instead of silently using AP currency", async () => {
    const result = await readPdf(syntheticPdf(), "EUR");
    expect(result.status).toBe("needs_review"); expect(result.currency).toBe("NOK");
  });
  it("normalizes a Norwegian printed invoice date", async () => {
    expect((await readPdf(syntheticPdf("01.01.2026"), "NOK")).invoiceDate).toBe("2026-01-01");
  });
  it("does not accept arbitrary bytes as a PDF", async () => {
    await expect(readPdf(Buffer.from("<html>sign in</html>"))).rejects.toThrow("Invalid PDF signature");
    await expect(readPdf(Buffer.from("%PDF-1.4 broken"))).rejects.toThrow("could not be read");
  });
  it("reads a genuinely image-only PDF with local OCR and keeps it in review", async () => {
    const fixture = await readFile(new URL("./fixtures/scanned-invoice.pdf.base64", import.meta.url), "utf8");
    const result = await readPdf(Buffer.from(fixture.trim(), "base64"), "NOK");
    expect(result.pagesRead).toBe(1);
    expect(result.text.toUpperCase()).toContain("SCANNED INVOICE");
    expect(result.status).toBe("needs_review");
    expect(result.warnings.join(" ")).toContain("OCR");
  }, 30_000);
});
