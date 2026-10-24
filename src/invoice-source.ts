import type { GqlRunner } from "./graphql.js";
import { validateDateRange } from "./validation.js";

export const INVOICE_SOURCES = ["apTransactions", "vendorInvoices"] as const;
export type InvoiceSource = typeof INVOICE_SOURCES[number];
export interface DocumentRef { dbId: string; ownerDbId: number; url: string; fileName: string; sourcePath: string }
export interface SourceInvoice {
  source: InvoiceSource; dbId: string; ownerDbId: number; invoiceNumber: string | null; invoiceDate: string | null;
  invoiceAmount: string | null; transactionHeaderDbId: string | null; supplierId: string | null; supplier: string | null;
  currency: string | null; documents: DocumentRef[];
}
const config = {
  apTransactions: { supplier: "subledger", supplierId: "subledgerDbId" },
  vendorInvoices: { supplier: "supplier", supplierId: "supplierDbId" },
};
const id = (v: unknown) => v == null ? null : String(v);
export function positiveId(value: string): string {
  if (!/^[1-9]\d{0,9}$/.test(value) || BigInt(value) > 2147483647n) throw new Error("Expected a positive Xledger Int dbId");
  return value;
}
export async function currentInvoiceEntity(run: GqlRunner): Promise<number> {
  const data = await run("{ entities(first: 2, ownerSet: CURRENT) { edges { node { dbId } } } }");
  const rows = data.entities?.edges;
  if (!Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(rows[0]?.node?.dbId)) throw new Error("Exactly one CURRENT entity must be verified before reading invoice documents");
  return rows[0].node.dbId;
}

// These paths and Url fields were verified by authenticated introspection and
// actual record reads on 2026-10-24. In particular, the AP attachment lives on
// transactionHeader.invoiceFile even when APTransaction.invoiceFile is null.
export async function listSourceInvoices(run: GqlRunner, options: {
  source: InvoiceSource; owner: number; first?: number; after?: string;
  fromDate?: string; toDate?: string; supplierId?: string; dbId?: string;
}) {
  if (!INVOICE_SOURCES.includes(options.source)) throw new Error("Unsupported invoice source");
  validateDateRange(options.fromDate, options.toDate);
  const first = options.first ?? 100;
  if (!Number.isInteger(first) || first < 1 || first > 200) throw new Error("Invoice page size must be 1–200");
  if (options.after != null && (!options.after.length || options.after.length > 2000)) throw new Error("Invalid invoice cursor");
  const c = config[options.source];
  const filters = [`ownerDbId: ${positiveId(String(options.owner))}`];
  if (options.dbId) filters.push(`dbId: ${positiveId(options.dbId)}`);
  if (options.supplierId) filters.push(`${c.supplierId}: ${positiveId(options.supplierId)}`);
  if (options.fromDate) filters.push(`invoiceDate_gte: ${JSON.stringify(options.fromDate)}`);
  if (options.toDate) filters.push(`invoiceDate_lte: ${JSON.stringify(options.toDate)}`);
  const file = "dbId ownerDbId url fileName";
  const data = await run(`{ ${options.source}(first: ${first}, ownerSet: CURRENT, filter: { ${filters.join(", ")} }${options.after ? `, after: ${JSON.stringify(options.after)}` : ""}) {
    pageInfo { hasNextPage } edges { cursor node {
      dbId ownerDbId invoiceNumber invoiceDate invoiceAmount transactionHeaderDbId ${c.supplierId}
      ${c.supplier} { dbId description } currency { code }
      invoiceFile { ${file} } transactionHeader { dbId ownerDbId invoiceFile { ${file} } }
    } }
  } }`);
  const connection = data[options.source];
  if (!connection || !Array.isArray(connection.edges) || typeof connection.pageInfo?.hasNextPage !== "boolean" || connection.edges.length > first)
    throw new Error("Invalid or incomplete invoice source page");
  const rows: SourceInvoice[] = connection.edges.map((edge: any) => {
    const n = edge?.node;
    if (!n || n.dbId == null || n.ownerDbId !== options.owner || (options.dbId && String(n.dbId) !== options.dbId)) throw new Error("Invoice identity/owner does not match the scoped request");
    if (options.supplierId && String(n[c.supplierId]) !== options.supplierId) throw new Error("Invoice supplier does not match the scoped request");
    if (n[c.supplier] && String(n[c.supplier].dbId) !== String(n[c.supplierId])) throw new Error("Invoice supplier relation identity mismatch");
    if ((options.fromDate && (!n.invoiceDate || n.invoiceDate < options.fromDate)) || (options.toDate && (!n.invoiceDate || n.invoiceDate > options.toDate))) throw new Error("Invoice date falls outside the scoped period");
    const th = n.transactionHeader;
    if (th && (th.ownerDbId !== options.owner || String(th.dbId) !== String(n.transactionHeaderDbId))) throw new Error("Transaction header identity/owner mismatch");
    const documents: DocumentRef[] = [];
    for (const [path, f] of [["invoiceFile", n.invoiceFile], ["transactionHeader.invoiceFile", th?.invoiceFile]] as const) {
      if (!f?.url) continue;
      if (f.ownerDbId !== options.owner || f.dbId == null || typeof f.url !== "string") throw new Error("Invoice document identity/owner mismatch");
      if (!documents.some(d => d.dbId === String(f.dbId))) documents.push({ dbId: String(f.dbId), ownerDbId: f.ownerDbId,
        url: f.url, fileName: String(f.fileName || "invoice"), sourcePath: `${options.source}.${path}` });
    }
    return { source: options.source, dbId: String(n.dbId), ownerDbId: n.ownerDbId, invoiceNumber: n.invoiceNumber || null,
      invoiceDate: n.invoiceDate || null, invoiceAmount: n.invoiceAmount ?? null, transactionHeaderDbId: id(n.transactionHeaderDbId),
      supplierId: id(n[c.supplierId]), supplier: n[c.supplier]?.description ?? null, currency: n.currency?.code ?? null, documents };
  });
  const more = connection.pageInfo.hasNextPage as boolean;
  const cursor = connection.edges.at(-1)?.cursor;
  if (more && (typeof cursor !== "string" || !cursor || cursor === options.after)) throw new Error("Invoice source has more records but no advancing continuation cursor");
  if (new Set(rows.map(r => r.dbId)).size !== rows.length) throw new Error("Invoice page contains duplicate source record IDs");
  return { rows, hasMore: more, nextCursor: more ? cursor as string : null };
}

export async function getSourceInvoice(run: GqlRunner, source: InvoiceSource, dbId: string, owner?: number) {
  const entity = owner ?? await currentInvoiceEntity(run);
  const page = await listSourceInvoices(run, { source, owner: entity, dbId, first: 2 });
  if (page.rows.length !== 1 || page.hasMore) throw new Error("The exact invoice was not found in the CURRENT entity");
  return page.rows[0];
}
export function publicInvoice(invoice: SourceInvoice) {
  return { ...invoice, documents: invoice.documents.map(({ url: _url, ...safe }) => safe) };
}
