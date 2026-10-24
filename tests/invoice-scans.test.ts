import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvoiceScans, sharedInvoiceScans } from "../src/invoice-scans.js";
import { readSourceInvoice } from "../src/invoice-reader.js";
import { apiNode, connection } from "./invoice-fixtures.js";
import { ehf } from "./invoice-fixtures.js";

const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
async function folder() { const d = await mkdtemp(join(tmpdir(), "xledger-scan-test-")); directories.push(d); return d; }
const options = { fromDate: "2026-01-01", toDate: "2026-01-31", includeUnposted: false };
const entity = { entities: { edges: [{ node: { dbId: 7 } }] } };
const reader = (failId?: string) => async (invoice: any, origin: string) => readSourceInvoice(invoice, origin, { download: async () => {
  if (invoice.dbId === failId) throw new Error("Document download returned HTTP 404");
  return ehf({ number: invoice.invoiceNumber });
} });

describe("full-period invoice scan", () => {
  it("shares a worker across MCP sessions using the same connection", () => {
    const run = vi.fn();
    expect(sharedInvoiceScans(run, "https://demo.xledger.net/graphql")).toBe(sharedInvoiceScans(run, "https://demo.xledger.net/graphql"));
    expect(sharedInvoiceScans(run, "https://demo.xledger.net/graphql")).not.toBe(sharedInvoiceScans(run, "https://www.xledger.net/graphql"));
  });
  it("continues through every source page, records every invoice and never calls an early page complete", async () => {
    const run = vi.fn(async (q: string) => {
      if (q.includes("entities(")) return entity;
      if (q.includes('after: "c2"')) return connection("apTransactions", [apiNode(12)], false);
      if (q.includes('after: "c1"')) return connection("apTransactions", [apiNode(11)], true, "c2");
      return connection("apTransactions", [apiNode(10)], true, "c1");
    });
    const scans = new InvoiceScans(run, "https://demo.xledger.net/graphql", await folder(), reader());
    const start = await scans.start(options); expect(start.coverage.allInvoicesRead).toBe(false);
    await scans.waitForIdle();
    const result = await scans.get(start.scanId, 0, 2);
    expect(result).toMatchObject({ status: "complete", coverage: { enumerationComplete: true, sourceComplete: true, processedRecords: 3, counts: { read: 3 } }, nextOffset: 2, invoiceOutputComplete: false });
    const last = await scans.get(start.scanId, 2, 2); expect(last.invoices[0].invoice.dbId).toBe("12");
    expect(JSON.stringify(result)).not.toContain("signature=private");
  });
  it("keeps 404s, missing documents and noninvoice payments distinct", async () => {
    const run = async (q: string) => q.includes("entities(") ? entity : connection("apTransactions", [apiNode(10), apiNode(11, { invoiceFile: null, transactionHeader: null }), apiNode(12, { invoiceNumber: null })]);
    const scans = new InvoiceScans(run, "https://demo.xledger.net/graphql", await folder(), reader("10"));
    const start = await scans.start(options); await scans.waitForIdle();
    const result = await scans.get(start.scanId);
    expect(result).toMatchObject({ status: "partial", coverage: { enumerationComplete: true, sourceComplete: false, counts: { failed: 1, missing_document: 1, not_numbered: 1 } } });
    expect((await scans.prices(start.scanId)).provisional).toBe(true);
  });
  it("does not turn a vendor permission failure into complete zero invoices", async () => {
    const run = async (q: string) => {
      if (q.includes("entities(")) return entity;
      if (q.includes("vendorInvoices(")) throw new Error("No VendorInvoice read permission");
      return connection("apTransactions", []);
    };
    const scans = new InvoiceScans(run, "https://demo.xledger.net/graphql", await folder(), reader());
    const start = await scans.start({ ...options, includeUnposted: true }); await scans.waitForIdle();
    const result = await scans.get(start.scanId);
    expect(result.coverage.enumerationComplete).toBe(false); expect(result.status).toBe("failed");
    expect(result.coverage.sources[1].error).toContain("permission");
  });
  it("refuses repeated source pages instead of skipping/looping indefinitely", async () => {
    const run = async (q: string) => q.includes("entities(") ? entity : connection("apTransactions", [apiNode(10)], true, q.includes("after:") ? "c2" : "c1");
    const scans = new InvoiceScans(run, "https://demo.xledger.net/graphql", await folder(), reader());
    const start = await scans.start(options); await scans.waitForIdle();
    const result = await scans.get(start.scanId);
    expect(result.status).toBe("failed"); expect(result.coverage.processedRecords).toBe(1);
    expect(result.coverage.sources[0].error).toContain("repeated");
  });
  it("retries a failed invoice from a persisted checkpoint without skipping it", async () => {
    const directory = await folder();
    const run = async (q: string) => q.includes("entities(") ? entity : connection("apTransactions", [apiNode(10)]);
    const first = new InvoiceScans(run, "https://demo.xledger.net/graphql", directory, reader("10"));
    const start = await first.start(options); await first.waitForIdle();
    const recovered = new InvoiceScans(run, "https://demo.xledger.net/graphql", directory, reader());
    await recovered.resume(start.scanId); await recovered.waitForIdle();
    expect(await recovered.get(start.scanId)).toMatchObject({ status: "complete", coverage: { processedRecords: 1, allInvoicesRead: true } });
  });
  it("reports interrupted work after restart and resumes the pending invoice before more pages", async () => {
    const directory = await folder();
    const run = async (q: string) => q.includes("entities(") ? entity : connection("apTransactions", [apiNode(11)]);
    const scans = new InvoiceScans(run, "https://demo.xledger.net/graphql", directory, reader());
    const start = await scans.start(options); await scans.waitForIdle();
    const scope = (await readdir(directory))[0], file = join(directory, scope, `${start.scanId}.json`);
    const state = JSON.parse(await readFile(file, "utf8")); state.status = "running";
    state.invoices = []; state.pending = [{ source: "apTransactions", dbId: "11" }];
    await writeFile(file, JSON.stringify(state));
    const recovered = new InvoiceScans(run, "https://demo.xledger.net/graphql", directory, reader());
    expect((await recovered.get(start.scanId)).status).toBe("interrupted");
    await recovered.resume(start.scanId); await recovered.waitForIdle();
    expect((await recovered.get(start.scanId)).coverage.allInvoicesRead).toBe(true);
  });
});
