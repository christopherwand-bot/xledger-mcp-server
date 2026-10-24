import { describe, expect, it } from "vitest";
import { readEhf } from "../src/ehf-reader.js";
import { ehf } from "./invoice-fixtures.js";

describe("original EHF lines", () => {
  it("preserves leading IDs and exact quantities/prices with source evidence", () => {
    const p = readEhf(ehf());
    expect(p).toMatchObject({ status: "read", invoiceNumber: "SYN-1", currency: "NOK", lineNetTotal: "600", sellerId: "999999999" });
    expect(p.lines[0]).toMatchObject({ id: "001", productId: "00012", quantity: "2", price: "300", priceBaseQuantity: "1", netUnitPrice: "300" });
  });
  it("applies a price per 100 units, line discount and charge exactly once", () => {
    const p = readEhf(ehf({ quantity: "10", unit: "KGM", price: "200", base: "100", net: "18", allowance: "5", charge: "3" }));
    expect(p.status).toBe("read"); expect(p.lines[0]).toMatchObject({ netUnitPrice: "1.8", price: "200", allowances: "5", charges: "3" });
  });
  it("does not subtract price-level discount a second time", () => {
    const b = ehf().toString().replace("</cac:Price>", '<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="NOK">20</cbc:Amount><cbc:BaseAmount currencyID="NOK">320</cbc:BaseAmount></cac:AllowanceCharge></cac:Price>');
    expect(readEhf(Buffer.from(b)).lines[0].netUnitPrice).toBe("300");
  });
  it.each([
    { base: "0" }, { base: "-1" }, { baseUnit: "KGM" }, { price: "300", net: "599" }, { quantity: "0", net: "0" }, { price: "-300", net: "-600" },
  ])("flags invalid/mismatched bases and unreconciled prices %j", options => {
    const p = readEhf(ehf(options)); expect(p.status).toBe("needs_review"); expect(p.lines).toHaveLength(0);
  });
  it("keeps credit notes separate and supports credited quantities", () => {
    const p = readEhf(ehf({ credit: true })); expect(p.creditNote).toBe(true); expect(p.status).toBe("read"); expect(p.lines).toHaveLength(1);
  });
  it("does not silently drop a malformed or duplicate line", () => {
    const b = ehf().toString(); const match = b.match(/<cac:InvoiceLine>.*?<\/cac:InvoiceLine>/s)![0];
    const p = readEhf(Buffer.from(b.replace("</Invoice>", match + "</Invoice>")));
    expect(p.status).toBe("needs_review"); expect(p.warnings.join(" ")).toContain("duplicate line");
  });
  it("rejects inconsistent line currency", () => {
    const b = ehf().toString().replace('<cbc:PriceAmount currencyID="NOK">', '<cbc:PriceAmount currencyID="EUR">');
    expect(readEhf(Buffer.from(b)).status).toBe("needs_review");
  });
  it("decodes predefined XML escapes without permitting a DTD/XXE", () => {
    expect(readEhf(ehf({ description: "Test &amp; flour" })).lines[0].description).toBe("Test & flour");
    expect(() => readEhf(Buffer.from('<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + ehf()))).toThrow("DTD");
    expect(() => readEhf(Buffer.from('<Invoice>broken'))).toThrow("Invalid");
  });
  it("flags document-level adjustments without allocating them to individual products", () => {
    const p = readEhf(ehf({ extra: '<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="NOK">10</cbc:Amount></cac:AllowanceCharge>' }));
    expect(p.status).toBe("read"); expect(p.warnings.join(" ")).toContain("not allocated");
  });
  it("accepts a namespaced root and rejects a forged namespace hidden in a comment", () => {
    const xml = ehf().toString();
    expect(readEhf(Buffer.from(xml.replace('<Invoice xmlns=', '<ubl:Invoice xmlns:ubl=').replace('</Invoice>', '</ubl:Invoice>'))).status).toBe("read");
    const forged = xml.replace('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"', 'xmlns="urn:wrong"')
      .replace('<?xml version="1.0" encoding="UTF-8"?>', '<!-- <Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"> -->');
    expect(() => readEhf(Buffer.from(forged))).toThrow("namespace");
  });
});
