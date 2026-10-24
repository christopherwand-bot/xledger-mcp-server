import { Money, decimal } from "./ehf-reader.js";
import type { InvoiceLine } from "./invoice-model.js";
import type { InvoiceRead } from "./invoice-reader.js";

const normal = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function normalizedPrice(line: InvoiceLine) {
  const q = decimal(line.quantity), net = decimal(line.netAmount);
  if (!q.isPositive() || net.isNegative()) throw new Error("Only positive ordinary purchase quantities establish a purchase price");
  const unit = line.unit.toUpperCase();
  const baseUnits: Record<string, { unit: string; factor: string }> = {
    KGM: { unit: "kg", factor: "1" }, KG: { unit: "kg", factor: "1" }, GRM: { unit: "kg", factor: "0.001" },
    LTR: { unit: "litre", factor: "1" }, MLT: { unit: "litre", factor: "0.001" },
  };
  if (baseUnits[unit]) {
    const base = baseUnits[unit];
    const quantity = q.mul(base.factor);
    return { unit: base.unit, quantity: quantity.toFixed(), price: net.div(quantity).toFixed(), pack: null, basis: `Explicit invoice unit ${unit}` };
  }
  // A single explicit pack weight/volume is usable for items invoiced as units.
  // Multipacks, variable/catch weights and multiple sizes require review.
  const packs = [...line.description.matchAll(/(?<![\d.,])(\d+(?:[.,]\d+)?)\s*(kg|g|ml|l|liter)\b/giu)];
  if (["C62", "H87", "EA", "STK", "XBG"].includes(unit) && packs.length === 1 &&
      !/\d\s*[x×*/]\s*\d|\d\s*[-–]\s*\d|[±~]|\+\/-|variabel|ca\.?\s*\d|approx\.?\s*\d|catch\s*weight|\d\s*(?:kg|g|ml|l)\s*[x×*]\s*\d/i.test(line.description)) {
    const weight = decimal(packs[0][1].replace(",", "."));
    if (!weight.isPositive()) throw new Error("Invalid pack size");
    const mass = ["kg", "g"].includes(packs[0][2].toLowerCase());
    const factor = ["g", "ml"].includes(packs[0][2].toLowerCase()) ? "0.001" : "1";
    const packQuantity = weight.mul(factor), quantity = q.mul(packQuantity);
    return { unit: mass ? "kg" : "litre", quantity: quantity.toFixed(), price: net.div(quantity).toFixed(),
      pack: `${packQuantity.toFixed()} ${mass ? "kg" : "litre"}/${unit}`,
      basis: `Explicit pack size in original item text: ${packs[0][0]}` };
  }
  return { unit, quantity: q.toFixed(), price: net.div(q).toFixed(), pack: null, basis: "Original invoice unit; no weight/volume inferred" };
}

export function invoicePriceHistory(reads: InvoiceRead[], keywords: string[] = []) {
  const groups = new Map<string, any>();
  const excluded: Array<{ invoiceDbId: string; reason: string; lineId?: string }> = [];
  const seenDocuments = new Set<string>();
  for (const read of reads) {
    const doc = read.documents.find(d => d.documentId === read.selectedDocumentId);
    if (read.status !== "read" || !doc?.parsed || !doc.sha256 || !read.invoice.supplierId) {
      if (read.status !== "not_numbered") excluded.push({ invoiceDbId: read.invoice.dbId, reason: "Original invoice is not fully reconciled/read or has no supplier identity" });
      continue;
    }
    const duplicate = `${read.invoice.ownerDbId}:${read.invoice.supplierId}:${doc.sha256}`;
    if (seenDocuments.has(duplicate)) { excluded.push({ invoiceDbId: read.invoice.dbId, reason: "Identical original document already included; duplicate accounting record remains visible in coverage" }); continue; }
    seenDocuments.add(duplicate);
    if (doc.parsed.creditNote) { excluded.push({ invoiceDbId: read.invoice.dbId, reason: "Credit note; not a new ordinary purchase price" }); continue; }
    for (const line of doc.parsed.lines) {
      if (keywords.length && !keywords.some(k => normal(line.description).includes(normal(k)) || normal(line.productId || "").includes(normal(k)))) continue;
      try {
        if (line.confidence === "ocr_review") throw new Error("OCR quantities/prices need review");
        const price = normalizedPrice(line);
        // Preserve pack size even when comparing normalized kg/litre prices.
        const productKey = line.productId ? `sku:${line.productId}` : `text:${normal(line.description)}`;
        const packIdentity = price.pack ?? (["kg", "litre"].includes(price.unit) ? null : normal(line.description));
        const key = JSON.stringify([read.invoice.ownerDbId, read.invoice.supplierId, productKey, line.currency, price.unit, packIdentity]);
        let group = groups.get(key);
        if (!group) { group = { supplierId: read.invoice.supplierId, supplier: read.invoice.supplier, productId: line.productId,
          description: line.description, currency: line.currency, unit: price.unit, pack: price.pack, observations: [] }; groups.set(key, group); }
        group.observations.push({ invoiceNumber: read.invoice.invoiceNumber, invoiceDate: read.invoice.invoiceDate,
          invoiceDbId: read.invoice.dbId, source: read.invoice.source, documentId: doc.documentId,
          sha256: doc.sha256, fileName: doc.fileName, sourcePath: doc.sourcePath, page: line.page, lineId: line.id,
          originalQuantity: line.quantity, originalUnit: line.unit, originalPrice: line.price, priceBaseQuantity: line.priceBaseQuantity,
          lineNetAmount: line.netAmount, quantity: price.quantity, unitPriceExVat: price.price, normalizationBasis: price.basis,
          allowances: line.allowances, charges: line.charges, evidence: line.evidence });
      } catch (error) { excluded.push({ invoiceDbId: read.invoice.dbId, lineId: line.id, reason: error instanceof Error ? error.message : "Price could not be normalized" }); }
    }
  }
  const output = [...groups.values()].map(group => {
    const rows: any[] = group.observations.sort((a: any, b: any) => String(a.invoiceDate).localeCompare(String(b.invoiceDate)) || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
    const prices = rows.map(row => decimal(row.unitPriceExVat));
    const min = prices.reduce((a, b) => a.lte(b) ? a : b), max = prices.reduce((a, b) => a.gte(b) ? a : b);
    const total = rows.reduce((sum, row) => sum.plus(row.lineNetAmount), new Money(0));
    const quantity = rows.reduce((sum, row) => sum.plus(row.quantity), new Money(0));
    const latestDate = rows.at(-1).invoiceDate;
    const latest = rows.filter(row => row.invoiceDate === latestDate);
    const earlier = rows.filter(row => row.invoiceDate < latestDate);
    const priorDate = earlier.at(-1)?.invoiceDate;
    const prior = earlier.filter(row => row.invoiceDate === priorDate);
    const latestPriceSet = [...new Set(latest.map(row => row.unitPriceExVat))];
    const priorPriceSet = [...new Set(prior.map(row => row.unitPriceExVat))];
    const delta = latestPriceSet.length === 1 && priorPriceSet.length === 1 ? decimal(latestPriceSet[0]).minus(priorPriceSet[0]) : null;
    const percent = delta && decimal(priorPriceSet[0]).isPositive() ? delta.div(priorPriceSet[0]).mul(100).toFixed() : null;
    return { ...group, observationCount: rows.length, minUnitPriceExVat: min.toFixed(), maxUnitPriceExVat: max.toFixed(),
      minPriceEvidence: rows.find(r => decimal(r.unitPriceExVat).eq(min)), maxPriceEvidence: rows.find(r => decimal(r.unitPriceExVat).eq(max)),
      weightedUnitPriceExVat: total.div(quantity).toFixed(), latestDate, latestPricesExVat: latestPriceSet,
      previousDistinctDate: priorDate ?? null, changeExVat: delta?.toFixed() ?? null, changePercent: percent,
      scope: "Line net prices excluding VAT; document-level freight/discounts are not allocated" };
  });
  return { groups: output, excluded, comparisonRule: "Same supplier, exact SKU (otherwise exact normalized description), currency, normalized unit and pack size. Credits and unverified/OCR rows are excluded." };
}
