import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { decimal, Money } from "./ehf-reader.js";
import type { InvoiceLine, ParsedInvoice } from "./invoice-model.js";

const exec = promisify(execFile);
export interface PdfWord { text: string; x: number; y: number; width: number; confidence?: number }
export interface PdfPage { number: number; words: PdfWord[]; ocr: boolean }
const array = (x: any): any[] => x == null ? [] : Array.isArray(x) ? x : [x];
const MAX_PAGES = 100;
const MAX_TEXT = 2_000_000;
const normal = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

export function pageRows(page: PdfPage): PdfWord[][] {
  const rows: PdfWord[][] = [];
  for (const word of [...page.words].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows.find(r => Math.abs(r[0].y - word.y) <= 2.5);
    if (row) row.push(word); else rows.push([word]);
  }
  return rows.sort((a, b) => a[0].y - b[0].y).map(row => row.sort((a, b) => a.x - b.x));
}
function localNumber(text: string, maxDecimals = 12): string {
  let s = text.replace(/[\s\u00a0]/g, "").replace(/−/g, "-");
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  if ((s.split(".")[1]?.length ?? 0) > maxDecimals) throw new Error("Ambiguous numeric format or excess monetary decimals");
  // A lone dot is a decimal separator. Ambiguous thousands-only formats fail
  // reconciliation rather than being silently interpreted as a larger price.
  return decimal(s).toFixed();
}
const unitCodes: Record<string, string> = { kg: "KGM", g: "GRM", l: "LTR", liter: "LTR", stk: "C62", st: "C62", pcs: "C62", ea: "C62", sekk: "XBG", sekker: "XBG" };

/** Conservative positioned table reader: explicit quantity, unit, price and net columns. */
export function readPdfTable(pages: PdfPage[], currency: string): { lines: InvoiceLine[]; warnings: string[]; lineNetTotal: string | null } {
  const lines: InvoiceLine[] = [], warnings: string[] = [];
  let lineNetTotal: string | null = null;
  for (const page of pages) {
    const rows = pageRows(page);
    let columns: { descEnd: number; qtyLeft: number; qtyRight: number; priceRight: number; netRight: number } | null = null;
    let candidateCount = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], text = row.map(w => w.text).join(" ");
      // Villa Import uses headings on two lines; include nearby header words.
      const nearby = rows.filter(r => Math.abs(r[0].y - row[0].y) <= 12).flat();
      const desc = row.find(w => /^(beskrivelse|varebeskrivelse|varetekst|description)$/i.test(w.text));
      const qty = nearby.find(w => /^(leveres|antall|mengde|quantity|qty)$/i.test(w.text));
      const price = nearby.find(w => /^(enh\.?pris|enhetspris|unitprice|pris)$/i.test(w.text));
      const net = nearby.filter(w => /^(bel[oø]p|nettobeløp|netamount|amount)$/i.test(w.text)).sort((a, b) => a.x - b.x)[0];
      const unit = nearby.find(w => /^(enhet|unit)$/i.test(w.text));
      const ordered = nearby.find(w => /^(bestilt|ordered)$/i.test(w.text));
      if (desc && qty && price && net && desc.x < qty.x && qty.x < price.x && price.x < net.x) {
        if (!nearby.some(w => /ekskl|excl|netto/i.test(w.text))) { warnings.push(`Page ${page.number}: table does not establish prices excluding VAT`); continue; }
        columns = { descEnd: ordered?.x ?? qty.x - 40, qtyLeft: ordered ? ordered.x + ordered.width + 2 : qty.x - 40,
          qtyRight: (unit ?? qty).x + (unit ?? qty).width + 2, priceRight: price.x + price.width + 2, netRight: net.x + net.width + 2 };
        continue;
      }
      if (!columns) continue;
      const c = columns;
      if (/^(sum|subtotal|mva|moms|totalt|total|å betale|til betaling|netto|betalings)/i.test(text.trim())) {
        if (/^(sum|total)\b/i.test(text.trim())) {
          try { lineNetTotal = localNumber(row.filter(w => w.x > c.priceRight && w.x + w.width <= c.netRight).map(w => w.text).join(""), 2); } catch { /* No reliable net total. */ }
        }
        columns = null; continue;
      }
      const d = row.filter(w => w.x < c.descEnd).map(w => w.text).join(" ");
      const qTokens = row.filter(w => w.x > c.qtyLeft && w.x + w.width <= c.qtyRight).map(w => w.text);
      const pTokens = row.filter(w => w.x > c.qtyRight && w.x + w.width <= c.priceRight).map(w => w.text);
      const nTokens = row.filter(w => w.x > c.priceRight && w.x + w.width <= c.netRight).map(w => w.text);
      if (!qTokens.length || !pTokens.length || !nTokens.length) continue;
      candidateCount++;
      try {
        const numeric = (parts: string[]) => parts.filter(t => /^-?[\d.,\s]+$/.test(t));
        const quantities = numeric(qTokens), prices = numeric(pTokens), amounts = numeric(nTokens);
        // Multiple quantity cells (ordered vs delivered) are deliberately not
        // guessed: require a single numeric value in the delivered column.
        if (quantities.length !== 1 || !prices.length || !amounts.length || !d) throw new Error("Ambiguous table columns");
        const quantity = decimal(localNumber(quantities[0]));
        const priceValue = decimal(localNumber(prices.join("")));
        const netValue = decimal(localNumber(amounts.join(""), 2));
        const unitToken = qTokens.map(t => t.toLowerCase().replace(/[.]/g, "")).find(t => unitCodes[t]);
        if (!unitToken || quantity.isZero() || priceValue.isNegative()) throw new Error("Missing unit or invalid quantity/price");
        if (quantity.mul(priceValue).minus(netValue).abs().gt("0.02")) throw new Error("Quantity × price does not reconcile; discount or price basis needs review");
        let description = d;
        // Some suppliers wrap the item name immediately below the numeric row.
        const following = rows[i + 1];
        if (following && following.every(w => w.x < c.descEnd) && !/^(sum|total|mva|levering|betaling)/i.test(following.map(w => w.text).join(" "))) {
          description += " " + following.map(w => w.text).join(" "); i++;
        }
        lines.push({ id: `${page.number}:${lines.length + 1}`, description, productId: null,
          quantity: quantity.toFixed(), unit: unitCodes[unitToken], price: priceValue.toFixed(), priceBaseQuantity: "1",
          netAmount: netValue.toFixed(), netUnitPrice: netValue.div(quantity).toFixed(), currency,
          allowances: "0", charges: "0", page: page.number, evidence: text,
          confidence: page.ocr ? "ocr_review" : "reconciled_pdf" });
      } catch (error) { warnings.push(`Page ${page.number}: ${error instanceof Error ? error.message : "Unreadable table row"}: ${text.slice(0, 240)}`); }
    }
    if (candidateCount === 0) warnings.push(`Page ${page.number}: no supported item table; text is available for review`);
  }
  if (lineNetTotal == null) warnings.push("No reliable document line net total for PDF reconciliation");
  else if (lines.reduce((sum, l) => sum.plus(l.netAmount), new Money(0)).minus(lineNetTotal).abs().gt("0.02")) warnings.push("PDF item lines do not reconcile with the document line net total");
  return { lines, warnings, lineNetTotal };
}

export async function readPdf(bytes: Buffer, expectedCurrency?: string): Promise<ParsedInvoice> {
  const deadline = Date.now() + 90_000;
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("Invalid PDF signature");
  const directory = await mkdtemp(join(tmpdir(), "xledger-invoice-"));
  const file = join(directory, "invoice.pdf");
  try {
    await writeFile(file, bytes, { mode: 0o600 });
    const info = await exec("pdfinfo", [file], { timeout: 15_000, maxBuffer: 256_000 });
    const pageCount = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("Could not establish the PDF page count");
    const { stdout } = await exec("pdftotext", ["-f", "1", "-l", String(Math.min(pageCount, MAX_PAGES)), "-bbox-layout", "-enc", "UTF-8", file, "-"], { timeout: 30_000, maxBuffer: 20 * 1024 * 1024 });
    const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: true }).parse(stdout);
    const rawPages = array(parsed.html?.body?.doc?.page);
    const pages: PdfPage[] = rawPages.map((p, index) => {
      const words: PdfWord[] = [];
      const visit = (value: any) => {
        if (!value || typeof value !== "object") return;
        if (value.word) for (const w of array(value.word)) words.push({ text: String(w["#text"] ?? ""),
          x: Number(w["@_xMin"]), y: Number(w["@_yMin"]), width: Number(w["@_xMax"]) - Number(w["@_xMin"]) });
        for (const [key, child] of Object.entries(value)) if (key !== "word") for (const c of array(child)) visit(c);
      };
      visit(p); return { number: index + 1, words, ocr: false };
    });
    const warnings: string[] = [];
    const sparse = pages.filter(p => p.words.map(w => w.text).join("").length < 30);
    for (const page of sparse) {
      if (Date.now() >= deadline) { warnings.push(`PDF processing time limit reached; remaining scanned pages were not read`); break; }
      try {
        const image = join(directory, `page-${page.number}`);
        await exec("pdftoppm", ["-f", String(page.number), "-l", String(page.number), "-singlefile", "-r", "150", "-scale-to", "2500", "-png", file, image], { timeout: 30_000, maxBuffer: 256_000 });
        const { stdout: languages } = await exec("tesseract", ["--list-langs"], { timeout: 5_000 });
        const lang = /^nor$/m.test(languages) ? "nor+eng" : "eng";
        const result = await exec("tesseract", [`${image}.png`, "stdout", "-l", lang, "--psm", "3", "tsv"], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
        page.words = result.stdout.split(/\r?\n/).slice(1).flatMap(line => {
          const cols = line.split("\t");
          return cols[0] === "5" && cols[11]?.trim() ? [{ text: cols.slice(11).join("\t"), x: Number(cols[6]) * 0.48,
            y: Number(cols[7]) * 0.48, width: Number(cols[8]) * 0.48, confidence: Number(cols[10]) }] : [];
        });
        page.ocr = true;
        warnings.push(`Page ${page.number}: OCR was used; quantities and prices require review`);
        if (!page.words.length) warnings.push(`Page ${page.number}: no readable text after OCR`);
      } catch { warnings.push(`Page ${page.number}: OCR failed or timed out; page was not read`); }
    }
    let text = pages.map(p => `[Page ${p.number}${p.ocr ? "; OCR" : ""}]\n${pageRows(p).map(r => r.map(w => w.text).join(" ")).join("\n")}`).join("\n\n");
    if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); warnings.push("Extracted text exceeds the output limit; document is incomplete"); }
    const seenCurrencies = [...new Set(text.match(/\b(?:NOK|EUR|USD|SEK|DKK|GBP)\b/g) ?? [])];
    const currency = seenCurrencies.length === 1 ? seenCurrencies[0] : null;
    if (expectedCurrency && currency !== expectedCurrency) warnings.push("PDF currency is missing, ambiguous, or differs from the Xledger invoice");
    const table = currency ? readPdfTable(pages, currency) : { lines: [], warnings: ["No verified document currency"], lineNetTotal: null };
    warnings.push(...table.warnings);
    if (pageCount > MAX_PAGES) warnings.push(`PDF has ${pageCount} pages; only ${MAX_PAGES} were read`);
    if (pages.length !== Math.min(pageCount, MAX_PAGES)) warnings.push("PDF page extraction is incomplete");
    const invoiceNumber = text.match(/(?:faktura(?:nummer|nr\.?|\s*nr\.?)|invoice\s*(?:number|no\.?|#))\s*[:#]?\s*([\w/-]+)/i)?.[1] ?? null;
    const creditNote = pages.some(p => pageRows(p).some(row => /^(kreditnota|credit\s*note)(?:\s+(?:nr|no)\.?\s*:?\s*[\w/-]+)?$/i.test(row.map(w => w.text).join(" ").trim())));
    const rawDate = text.match(/(?:fakturadato|invoice\s*date)\s*:?\s*(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})/i)?.[1];
    const invoiceDate = rawDate?.includes(".") ? rawDate.split(".").reverse().join("-") : rawDate ?? null;
    if (!invoiceNumber || !invoiceDate) warnings.push("PDF invoice number/date could not be established");
    return { format: "pdf", invoiceNumber, invoiceDate, seller: null, sellerId: null, buyerId: null, currency, creditNote,
      lines: table.lines, text, pages: pageCount, pagesRead: pages.filter(p => p.words.length > 0).length,
      status: warnings.length || !table.lines.length ? "needs_review" : "read", warnings, lineNetTotal: table.lineNetTotal };
  } catch (error) {
    // Child-process errors include paths/stderr. Return a bounded generic error;
    // never echo command input or invoice content into platform logs.
    if (error instanceof Error && error.message.startsWith("Invalid PDF")) throw error;
    throw new Error("PDF could not be read (encrypted, malformed, missing local PDF utilities, or processing timeout)");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
