import { XMLParser, XMLValidator } from "fast-xml-parser";
import { Decimal } from "decimal.js";
import type { InvoiceLine, ParsedInvoice } from "./invoice-model.js";

export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export function decimal(value: unknown, label = "decimal"): InstanceType<typeof Money> {
  const text = String(value ?? "");
  if (!/^-?\d{1,20}(?:\.\d{1,12})?$/.test(text)) throw new Error(`Invalid ${label}`);
  return new Money(text);
}
const list = (value: any): any[] => value == null ? [] : Array.isArray(value) ? value : [value];
const txt = (value: any): string => value == null ? "" : typeof value === "object" ? String(value["#text"] ?? "") : String(value);
const optional = (value: any): string | null => txt(value) || null;
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false,
  parseAttributeValue: false, trimValues: true, processEntities: true });

/** UBL/EHF Invoice and CreditNote only. No DTD, external entities or numeric coercion. */
export function readEhf(bytes: Buffer): ParsedInvoice {
  if (bytes.length > 30 * 1024 * 1024) throw new Error("EHF exceeds the 30 MiB document limit");
  const xml = bytes.toString("utf8").replace(/^\uFEFF/, "");
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error("DTD and entity declarations are not allowed");
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid invoice XML");
  // Prefix names are arbitrary; the document must still identify the UBL namespace.
  const structure = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "").trimStart();
  const tag = structure.match(/^<((?:[\w.-]+:)?)(Invoice|CreditNote)\b([^>]*)>/);
  const prefix = tag?.[1] ? `:${tag[1].slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "";
  const namespace = tag ? new RegExp(`(?:^|\\s)xmlns${prefix}\\s*=\\s*(["'])urn:oasis:names:specification:ubl:schema:xsd:${tag[2]}-2\\1`) : null;
  if (!tag || !namespace?.test(tag[3])) throw new Error("Unsupported XML: expected a UBL Invoice or CreditNote namespace on the root");
  const parsed = parser.parse(xml);
  const root = parsed.Invoice ?? parsed.CreditNote;
  if (!root || Array.isArray(root) || (parsed.Invoice && parsed.CreditNote)) throw new Error("Expected exactly one UBL invoice document");
  const creditNote = Boolean(parsed.CreditNote) || ["381", "396"].includes(txt(root.InvoiceTypeCode));
  const currency = txt(root.DocumentCurrencyCode);
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Missing or invalid document currency");
  const warnings: string[] = [];
  const rawLines = list(creditNote ? root.CreditNoteLine ?? root.InvoiceLine : root.InvoiceLine);
  const lines: InvoiceLine[] = [];
  const lineIds = new Set<string>();
  for (let index = 0; index < rawLines.length; index++) {
    const row = rawLines[index];
    const id = txt(row.ID);
    try {
      if (!id || lineIds.has(id)) throw new Error("Missing or duplicate line ID");
      lineIds.add(id);
      const q = row.InvoicedQuantity ?? row.CreditedQuantity;
      const quantity = decimal(txt(q), "quantity");
      const unit = txt(q?.["@_unitCode"]).toUpperCase();
      if (!unit) throw new Error("Missing quantity unit");
      const p = row.Price;
      if (!p || Array.isArray(p)) throw new Error("Missing item price");
      const price = decimal(txt(p.PriceAmount), "item net price");
      const base = decimal(p.BaseQuantity == null ? "1" : txt(p.BaseQuantity), "price base quantity");
      if (price.isNegative() || !base.isPositive()) throw new Error("Price must be nonnegative and price base must be positive");
      if (p.BaseQuantity != null && txt(p.BaseQuantity?.["@_unitCode"]) !== unit) throw new Error("Price base and invoiced quantity use different units");
      const amounts = [row.LineExtensionAmount, p.PriceAmount, ...list(row.AllowanceCharge).map(a => a.Amount)];
      if (amounts.some(a => a?.["@_currencyID"] !== currency)) throw new Error("Missing or inconsistent line currency");
      const net = decimal(txt(row.LineExtensionAmount), "line net amount");
      let allowances = new Money(0), charges = new Money(0);
      for (const ac of list(row.AllowanceCharge)) {
        const amount = decimal(txt(ac.Amount), "line allowance/charge");
        if (amount.isNegative()) throw new Error("Negative allowance/charge");
        if (txt(ac.ChargeIndicator) === "true") charges = charges.plus(amount);
        else if (txt(ac.ChargeIndicator) === "false") allowances = allowances.plus(amount);
        else throw new Error("Invalid allowance/charge indicator");
      }
      // EN16931-R120. PriceAmount is already net of any price-level discount.
      const expected = quantity.mul(price.div(base)).plus(charges).minus(allowances);
      if (expected.minus(net).abs().gt("0.02")) throw new Error("Quantity, price base, discounts and line net amount do not reconcile (R120)");
      if (quantity.isZero()) throw new Error("Zero quantity cannot establish a unit price");
      const description = [txt(row.Item?.Name), ...list(row.Item?.Description).map(txt)].filter(Boolean).join(" — ");
      if (!description) throw new Error("Missing item description");
      lines.push({ id, description, productId: optional(row.Item?.SellersItemIdentification?.ID), quantity: quantity.toFixed(),
        unit, price: price.toFixed(), priceBaseQuantity: base.toFixed(), netAmount: net.toFixed(), netUnitPrice: net.div(quantity).toFixed(),
        currency, allowances: allowances.toFixed(), charges: charges.toFixed(), page: null,
        evidence: `UBL ${creditNote ? "CreditNoteLine" : "InvoiceLine"}[ID=${id}]: quantity=${quantity} ${unit}; PriceAmount=${price}; BaseQuantity=${base}; LineExtensionAmount=${net}`,
        confidence: "structured" });
    } catch (error) {
      warnings.push(`Line ${id || index + 1}: ${error instanceof Error ? error.message : "Could not read line"}`);
    }
  }
  const monetary = root.LegalMonetaryTotal ?? root.RequestedMonetaryTotal;
  const statedTotal = optional(monetary?.LineExtensionAmount);
  if (statedTotal != null) {
    try {
      if (monetary.LineExtensionAmount?.["@_currencyID"] !== currency ||
          decimal(statedTotal).minus(lines.reduce((sum, line) => sum.plus(line.netAmount), new Money(0))).abs().gt("0.02"))
        warnings.push("Document line net total does not reconcile with the extracted lines");
    } catch { warnings.push("Invalid document line net total"); }
  } else warnings.push("Document has no line net total for reconciliation");
  if (!rawLines.length) warnings.push("Document contains no invoice lines");
  if (list(root.AllowanceCharge).length) warnings.push("Document-level allowances/charges are present and are not allocated to line prices");
  const supplier = root.AccountingSupplierParty?.Party;
  const buyer = root.AccountingCustomerParty?.Party;
  const invoiceNumber = optional(root.ID), invoiceDate = optional(root.IssueDate);
  if (!invoiceNumber || !invoiceDate || !/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) warnings.push("Missing or invalid invoice identity/date");
  // Header charges are a scope note, not a failed line read.
  const blocking = warnings.filter(w => !w.startsWith("Document-level"));
  return { format: "ehf", invoiceNumber, invoiceDate, seller: optional(supplier?.PartyName?.Name) ?? optional(supplier?.PartyLegalEntity?.RegistrationName),
    sellerId: optional(supplier?.PartyLegalEntity?.CompanyID), buyerId: optional(buyer?.PartyLegalEntity?.CompanyID),
    currency, creditNote, lines, text: xml, pages: 1, pagesRead: 1,
    status: blocking.length ? "needs_review" : "read", warnings, lineNetTotal: statedTotal };
}
