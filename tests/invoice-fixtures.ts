import type { SourceInvoice } from "../src/invoice-source.js";

// Entirely synthetic invoices. No company records or signed URLs in fixtures.
export function ehf(options: { number?: string; quantity?: string; unit?: string; price?: string; base?: string;
  baseUnit?: string | null; net?: string; allowance?: string; charge?: string; currency?: string;
  description?: string; credit?: boolean; extra?: string; date?: string } = {}) {
  const o = { number: "SYN-1", quantity: "2", unit: "C62", price: "300", base: "1", net: "600", currency: "NOK", description: "Test flour 25 kg", ...options };
  const root = o.credit ? "CreditNote" : "Invoice", line = o.credit ? "CreditNoteLine" : "InvoiceLine", qty = o.credit ? "CreditedQuantity" : "InvoicedQuantity";
  const baseUnitAttribute = o.baseUnit === null ? "" : ` unitCode="${o.baseUnit ?? o.unit}"`;
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <cbc:ID>${o.number}</cbc:ID><cbc:IssueDate>${o.date || "2026-01-01"}</cbc:IssueDate><cbc:DocumentCurrencyCode>${o.currency}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Synthetic supplier</cbc:Name></cac:PartyName><cac:PartyLegalEntity><cbc:CompanyID>999999999</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:CompanyID>888888888</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${o.currency}">${o.net}</cbc:LineExtensionAmount></cac:LegalMonetaryTotal>
  <cac:${line}><cbc:ID>001</cbc:ID><cbc:${qty} unitCode="${o.unit}">${o.quantity}</cbc:${qty}><cbc:LineExtensionAmount currencyID="${o.currency}">${o.net}</cbc:LineExtensionAmount>
  ${o.allowance ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="${o.currency}">${o.allowance}</cbc:Amount></cac:AllowanceCharge>` : ""}
  ${o.charge ? `<cac:AllowanceCharge><cbc:ChargeIndicator>true</cbc:ChargeIndicator><cbc:Amount currencyID="${o.currency}">${o.charge}</cbc:Amount></cac:AllowanceCharge>` : ""}
  <cac:Item><cbc:Name>${o.description}</cbc:Name><cac:SellersItemIdentification><cbc:ID>00012</cbc:ID></cac:SellersItemIdentification></cac:Item>
  <cac:Price><cbc:PriceAmount currencyID="${o.currency}">${o.price}</cbc:PriceAmount><cbc:BaseQuantity${baseUnitAttribute}>${o.base}</cbc:BaseQuantity></cac:Price></cac:${line}>${o.extra || ""}</${root}>`);
}
export function sourceInvoice(options: Partial<SourceInvoice> = {}): SourceInvoice {
  return { source: "apTransactions", dbId: "10", ownerDbId: 7, invoiceNumber: "SYN-1", invoiceDate: "2026-01-01",
    invoiceAmount: "-690", transactionHeaderDbId: "90", supplierId: "8", supplier: "Synthetic supplier", currency: "NOK",
    documents: [{ dbId: "100", ownerDbId: 7, url: "https://demo.xledger.net/Files2/synthetic.xml?signature=secret", fileName: "synthetic.xml", sourcePath: "apTransactions.transactionHeader.invoiceFile" }], ...options };
}

export function syntheticPdf(date = "2026-01-01") {
  const draw = (x: number, y: number, text: string) => `BT /F1 10 Tf ${x} ${y} Td (${text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")}) Tj ET`;
  const content = [draw(40, 760, "Fakturanr.: SYN-1"), draw(40, 740, `Fakturadato: ${date}`),
    draw(40, 650, "Beskrivelse"), draw(236, 650, "Bestilt"), draw(275, 650, "Leveres"), draw(340, 655, "Enh.pris"),
    draw(420, 655, "Belop"), draw(330, 644, "(ekskl. mva)"), draw(400, 644, "(ekskl. mva)"),
    draw(40, 620, "Test flour 25 kg"), draw(250, 620, "3"), draw(280, 620, "2 STK"), draw(340, 620, "300,00"), draw(410, 620, "600,00"),
    draw(40, 600, "Sum"), draw(410, 600, "600,00"), draw(480, 580, "NOK 690,00")].join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets: number[] = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

export const apiNode = (dbId = 10, overrides: any = {}) => ({ dbId, ownerDbId: 7, invoiceNumber: `SYN-${dbId}`, invoiceDate: "2026-01-01",
  invoiceAmount: "-690", transactionHeaderDbId: 90 + dbId, subledgerDbId: 8, supplierDbId: 8,
  subledger: { dbId: 8, description: "Synthetic supplier" }, supplier: { dbId: 8, description: "Synthetic supplier" }, currency: { code: "NOK" }, invoiceFile: null,
  transactionHeader: { dbId: 90 + dbId, ownerDbId: 7, invoiceFile: { dbId: String(100 + dbId), ownerDbId: 7, fileName: "synthetic.xml", url: "https://demo.xledger.net/Files2/synthetic.xml?signature=private" } }, ...overrides });
export const connection = (source: string, rows: any[], more = false, cursor = "next") => ({ [source]: { pageInfo: { hasNextPage: more }, edges: rows.map(node => ({ node, cursor })) } });
