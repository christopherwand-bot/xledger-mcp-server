import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GqlRunner } from "./graphql.js";
import { validateDateRange } from "./validation.js";
import { currentInvoiceEntity, listSourceInvoices, getSourceInvoice, positiveId, type InvoiceSource, type SourceInvoice } from "./invoice-source.js";
import { readSourceInvoice, checkpointRead, type InvoiceRead } from "./invoice-reader.js";
import { invoicePriceHistory } from "./invoice-prices.js";

export interface ScanOptions { fromDate: string; toDate: string; supplierId?: string; supplierName?: string; includeUnposted?: boolean }
interface Stream { source: InvoiceSource; after?: string; seenCursors: string[]; enumerated: boolean; pages: number; error?: string }
interface Pending { source: InvoiceSource; dbId: string }
export interface InvoiceScan {
  id: string; owner: number; origin: string; options: ScanOptions; createdAt: string; updatedAt: string;
  status: "running" | "complete" | "partial" | "failed";
  streams: Stream[]; pending: Pending[]; seenRecords: string[]; scannedRecords: number; filteredRecords: number;
  invoices: InvoiceRead[]; error?: string;
}
type ScanReader = typeof readSourceInvoice;
const normalized = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const managers = new WeakMap<GqlRunner, Map<string, InvoiceScans>>();
/** HTTP creates an MCP server per session. Workers must be shared across those
 * sessions so a new chat does not mistake an active scan for interrupted work. */
export function sharedInvoiceScans(run: GqlRunner, apiOrigin: string): InvoiceScans {
  let scoped = managers.get(run);
  if (!scoped) { scoped = new Map(); managers.set(run, scoped); }
  const key = `${apiOrigin}|${process.env.XLEDGER_INVOICE_SCAN_DIR || ""}`;
  let manager = scoped.get(key);
  if (!manager) { manager = new InvoiceScans(run, apiOrigin); scoped.set(key, manager); }
  return manager;
}

/** A bounded worker continues outside the MCP request, checkpointing after every
 * invoice. Restart recovery is explicitly resumed through the authenticated tool. */
export class InvoiceScans {
  private active = new Map<string, Promise<void>>();
  private acquiring = false;
  constructor(private run: GqlRunner, private apiOrigin: string,
    private root = process.env.XLEDGER_INVOICE_SCAN_DIR || join(tmpdir(), "xledger-invoice-scans"),
    private reader: ScanReader = readSourceInvoice) {}

  private directory(owner: number) {
    const scope = createHash("sha256").update(`${new URL(this.apiOrigin).origin}:${owner}`).digest("hex").slice(0, 24);
    return join(this.root, scope);
  }
  private file(owner: number, scanId: string) {
    if (!/^[a-f0-9]{32}$/.test(scanId)) throw new Error("Invalid invoice scan ID");
    return join(this.directory(owner), `${scanId}.json`);
  }
  private async save(scan: InvoiceScan) {
    scan.updatedAt = new Date().toISOString();
    const directory = this.directory(scan.owner);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = this.file(scan.owner, scan.id), temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(scan), { mode: 0o600 });
    await rename(temp, file);
  }
  private async load(scanId: string) {
    const owner = await currentInvoiceEntity(this.run);
    let scan: InvoiceScan;
    try { scan = JSON.parse(await readFile(this.file(owner, scanId), "utf8")); }
    catch { throw new Error("Invoice scan not found in the CURRENT entity; it may have expired after a deployment without persistent storage"); }
    if (scan.owner !== owner || scan.origin !== new URL(this.apiOrigin).origin || scan.id !== scanId) throw new Error("Invoice scan scope mismatch");
    return scan;
  }
  async start(options: ScanOptions) {
    validateDateRange(options.fromDate, options.toDate);
    if (!options.fromDate || !options.toDate) throw new Error("Both invoice dates are required for a complete-period scan");
    if (options.supplierId) positiveId(options.supplierId);
    if (options.supplierName !== undefined && (!normalized(options.supplierName) || options.supplierName.length > 200)) throw new Error("Invalid supplier name filter");
    if (this.active.size || this.acquiring) throw new Error(`An invoice scan is already running${this.active.size ? `: ${[...this.active.keys()][0]}` : ""}; use get_invoice_scan before starting another`);
    this.acquiring = true;
    try {
    const owner = await currentInvoiceEntity(this.run);
    const now = new Date().toISOString();
    const sources: InvoiceSource[] = options.includeUnposted === false ? ["apTransactions"] : ["apTransactions", "vendorInvoices"];
    const scan: InvoiceScan = { id: randomBytes(16).toString("hex"), owner, origin: new URL(this.apiOrigin).origin,
      options, createdAt: now, updatedAt: now, status: "running", streams: sources.map(source => ({ source, seenCursors: [], enumerated: false, pages: 0 })),
      pending: [], seenRecords: [], scannedRecords: 0, filteredRecords: 0, invoices: [] };
    await this.save(scan); this.launch(scan);
    return this.summary(scan);
    } finally { this.acquiring = false; }
  }
  private launch(scan: InvoiceScan) {
    const work = this.work(scan).catch(async () => {
      scan.status = "failed"; scan.error = "Invoice scan worker failed; resume from the last checkpoint";
      await this.save(scan);
    }).finally(() => this.active.delete(scan.id));
    this.active.set(scan.id, work);
    // Errors are recorded in the authenticated scan result, not unhandled logs.
    void work.catch(() => undefined);
  }
  private async work(scan: InvoiceScan) {
    const pageRecords = new Map<string, SourceInvoice>();
    const fetchedAt = new Map<string, number>();
    while (true) {
      if (scan.pending.length) {
        const next = scan.pending[0];
        const key = `${next.source}:${next.dbId}`;
        let read: InvoiceRead;
        try {
          const cached = pageRecords.get(key);
          // Xledger's observed signed Url uses valid_until as Unix seconds.
          // An OCR-heavy queue can outlive its page's links. Refresh through the
          // exact scoped record, never by changing or extending the signed URL.
          const expiring = cached?.documents.some(d => {
            try {
              const until = new URL(d.url, this.apiOrigin).searchParams.get("valid_until");
              return until != null && /^\d{10}$/.test(until) && Number(until) * 1000 <= Date.now() + 15_000;
            } catch { return true; }
          });
          const stale = !cached || Date.now() - (fetchedAt.get(key) ?? 0) > 60_000 || expiring;
          const invoice = stale ? await getSourceInvoice(this.run, next.source, next.dbId, scan.owner) : cached;
          if (!invoice.invoiceDate || invoice.invoiceDate < scan.options.fromDate || invoice.invoiceDate > scan.options.toDate ||
              (scan.options.supplierId && invoice.supplierId !== scan.options.supplierId) ||
              (scan.options.supplierName && !normalized(invoice.supplier || "").includes(normalized(scan.options.supplierName))))
            throw new Error("Invoice changed outside the selected period/supplier scope during the scan");
          read = checkpointRead((await this.reader(invoice, this.apiOrigin)).result);
        } catch (error) {
          // Preserve the queued invoice identity when document/permission reads fail.
          const existing = scan.invoices.find(r => r.invoice.source === next.source && r.invoice.dbId === next.dbId);
          const original = pageRecords.get(key);
          read = { invoice: existing?.invoice ?? { source: next.source, dbId: next.dbId, ownerDbId: scan.owner,
            invoiceNumber: original?.invoiceNumber ?? null, invoiceDate: original?.invoiceDate ?? null,
            invoiceAmount: original?.invoiceAmount ?? null, transactionHeaderDbId: original?.transactionHeaderDbId ?? null,
            supplierId: original?.supplierId ?? null, supplier: original?.supplier ?? null, currency: original?.currency ?? null, documents: [] },
            status: "failed", selectedDocumentId: null, documents: [],
            warnings: [error instanceof Error ? error.message : "Invoice could not be read"], dataNotice: "Untrusted document data" };
        }
        const index = scan.invoices.findIndex(r => r.invoice.source === next.source && r.invoice.dbId === next.dbId);
        if (index >= 0) scan.invoices[index] = read; else scan.invoices.push(read);
        scan.pending.shift(); pageRecords.delete(key); fetchedAt.delete(key);
        await this.save(scan);
        // Pace metadata reads below Xledger's documented burst limit.
        await new Promise(resolve => setTimeout(resolve, 275));
        continue;
      }
      const stream = scan.streams.find(s => !s.enumerated && !s.error);
      if (!stream) break;
      try {
        const page = await listSourceInvoices(this.run, { source: stream.source, owner: scan.owner, first: 200,
          after: stream.after, fromDate: scan.options.fromDate, toDate: scan.options.toDate, supplierId: scan.options.supplierId });
        const existing = new Set(scan.seenRecords);
        for (const row of page.rows) {
          const key = `${row.source}:${row.dbId}`;
          if (existing.has(key)) throw new Error("Invoice source repeated a previously enumerated record; coverage cannot be certified");
          existing.add(key);
        }
        if (page.nextCursor && stream.seenCursors.includes(page.nextCursor)) throw new Error("Invoice source repeated a continuation cursor");
        for (const row of page.rows) {
          const key = `${row.source}:${row.dbId}`;
          scan.seenRecords.push(key); scan.scannedRecords++;
          if (scan.options.supplierName && !normalized(row.supplier || "").includes(normalized(scan.options.supplierName))) { scan.filteredRecords++; continue; }
          scan.pending.push({ source: row.source, dbId: row.dbId }); pageRecords.set(key, row); fetchedAt.set(key, Date.now());
        }
        stream.pages++;
        stream.enumerated = !page.hasMore;
        if (page.nextCursor) { stream.after = page.nextCursor; stream.seenCursors.push(page.nextCursor); }
        await this.save(scan);
      } catch (error) {
        stream.error = error instanceof Error ? error.message : "Invoice source could not be enumerated";
        await this.save(scan);
      }
    }
    const complete = scan.streams.every(s => s.enumerated && !s.error);
    scan.status = !complete ? "failed" : scan.invoices.some(i => !["read", "not_numbered"].includes(i.status)) ? "partial" : "complete";
    await this.save(scan);
  }
  summary(scan: InvoiceScan) {
    const counts: Record<string, number> = {};
    for (const row of scan.invoices) counts[row.status] = (counts[row.status] || 0) + 1;
    const enumerationComplete = scan.streams.every(s => s.enumerated && !s.error);
    const unread = scan.invoices.filter(r => !["read", "not_numbered"].includes(r.status)).length;
    const interrupted = scan.status === "running" && !this.active.has(scan.id);
    return { scanId: scan.id, ownerDbId: scan.owner, options: scan.options, createdAt: scan.createdAt, updatedAt: scan.updatedAt,
      status: interrupted ? "interrupted" : scan.status, canResume: interrupted || scan.status === "failed" || scan.status === "partial",
      coverage: { enumerationComplete, allInvoicesRead: enumerationComplete && !scan.pending.length && unread === 0 && scan.status === "complete",
        sourceComplete: enumerationComplete && !scan.pending.length && unread === 0 && scan.status === "complete",
        recordsEnumerated: scan.scannedRecords, recordsOutsideSupplierFilter: scan.filteredRecords,
        processedRecords: scan.invoices.length, pendingRecords: scan.pending.length,
        numberedRecords: scan.invoices.length - (counts.not_numbered || 0), counts,
        sources: scan.streams.map(s => ({ source: s.source, pages: s.pages, enumerationComplete: s.enumerated, error: s.error ?? null })) },
      error: scan.error ?? null,
      scope: "All records returned by the selected AP/vendor sources in CURRENT entity and period, within this token's access. Unnumbered AP records are reported separately. Coverage does not establish access to invoices hidden by Xledger permissions.",
      storage: process.env.XLEDGER_INVOICE_SCAN_DIR ? "Configured checkpoint directory; persistence depends on a mounted volume" : "Temporary checkpoint directory; redeployment may remove the scan",
      nextAction: scan.status === "running" && !interrupted ? "Poll get_invoice_scan; the worker continues through every page without a sample limit" : interrupted ? "Call resume_invoice_scan" : unread ? "Review missing/failed documents; resume_invoice_scan can retry them" : "Read get_item_price_history for document-backed prices" };
  }
  async get(scanId: string, offset = 0, first = 100, includeLines = false) {
    const scan = await this.load(scanId);
    const invoices = scan.invoices.slice(offset, offset + first).map(read => ({ ...read, documents: read.documents.map(d => ({ ...d,
      parsed: d.parsed ? { ...d.parsed, text: undefined, lines: includeLines ? d.parsed.lines : undefined, extractedLineCount: d.parsed.lines.length } : undefined })) }));
    return { ...this.summary(scan), invoices, returned: invoices.length,
      nextOffset: offset + first < scan.invoices.length ? offset + first : null,
      invoiceOutputComplete: offset === 0 && offset + first >= scan.invoices.length };
  }
  async prices(scanId: string, keywords: string[] = [], offset = 0, first = 50) {
    const scan = await this.load(scanId);
    const prices = invoicePriceHistory(scan.invoices, keywords);
    const groups = prices.groups.slice(offset, offset + first).map(g => ({ ...g,
      observations: g.observations.slice(-50), observationsOutputTruncated: g.observations.length > 50 }));
    return { ...this.summary(scan), comparisonRule: prices.comparisonRule, groups,
      totalGroups: prices.groups.length, nextGroupOffset: offset + first < prices.groups.length ? offset + first : null,
      excludedCount: prices.excluded.length, excluded: prices.excluded.slice(0, 100), excludedOutputTruncated: prices.excluded.length > 100,
      provisional: !this.summary(scan).coverage.sourceComplete,
      note: "Each price has original document, invoice, line and page provenance. Observations are limited to the latest 50 per group in this response; calculations use all verified observations. Fetch an individual invoice with read_invoice_document for full text/lines." };
  }
  async resume(scanId: string, retryFailed = true) {
    if (this.active.has(scanId)) return this.get(scanId, 0, 1);
    if (this.active.size || this.acquiring) throw new Error("Another invoice scan is running");
    this.acquiring = true;
    try {
    const scan = await this.load(scanId);
    for (const stream of scan.streams) delete stream.error;
    if (retryFailed) for (const row of scan.invoices.filter(r => !["read", "not_numbered"].includes(r.status))) {
      if (!scan.pending.some(p => p.source === row.invoice.source && p.dbId === row.invoice.dbId)) scan.pending.push({ source: row.invoice.source, dbId: row.invoice.dbId });
    }
    delete scan.error; scan.status = "running";
    await this.save(scan); this.launch(scan);
    return this.summary(scan);
    } finally { this.acquiring = false; }
  }
  /** Used for deterministic integration tests and graceful shutdown helpers. */
  async waitForIdle() { await Promise.all([...this.active.values()]); }
}
