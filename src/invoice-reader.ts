import { createHash } from "node:crypto";
import { readEhf, decimal } from "./ehf-reader.js";
import { readPdf } from "./pdf-reader.js";
import { downloadInvoiceDocument } from "./invoice-download.js";
import { publicInvoice, type SourceInvoice } from "./invoice-source.js";
import { DOCUMENT_DATA_NOTICE, type ParsedInvoice } from "./invoice-model.js";

export interface DocumentRead {
  documentId: string; fileName: string; sourcePath: string; sha256: string | null; bytes: number | null;
  mimeType?: "application/pdf" | "application/xml";
  status: "read" | "needs_review" | "download_failed" | "unsupported_format" | "parse_failed" | "identity_mismatch";
  error?: string; parsed?: ParsedInvoice;
}
export interface InvoiceRead {
  invoice: ReturnType<typeof publicInvoice>;
  status: "read" | "needs_review" | "missing_document" | "failed" | "not_numbered";
  documents: DocumentRead[];
  selectedDocumentId: string | null;
  warnings: string[];
  dataNotice: string;
}
export interface ReaderDependencies {
  download?: typeof downloadInvoiceDocument;
  pdf?: typeof readPdf;
}

export async function readSourceInvoice(invoice: SourceInvoice, apiOrigin: string, dependencies: ReaderDependencies = {}) {
  const result: InvoiceRead = { invoice: publicInvoice(invoice), status: "missing_document", documents: [],
    selectedDocumentId: null, warnings: [], dataNotice: DOCUMENT_DATA_NOTICE };
  const blobs = new Map<string, Buffer>();
  if (!invoice.invoiceNumber) { result.status = "not_numbered"; result.warnings.push("Unnumbered AP record; not asserted to be an invoice"); return { result, blobs }; }
  if (!invoice.documents.length) { result.warnings.push("Xledger returned no invoiceFile on the invoice or its transaction header"); return { result, blobs }; }
  for (const ref of invoice.documents) {
    const doc: DocumentRead = { documentId: ref.dbId, fileName: ref.fileName, sourcePath: ref.sourcePath,
      sha256: null, bytes: null, status: "download_failed" };
    result.documents.push(doc);
    let bytes: Buffer;
    try {
      bytes = await (dependencies.download ?? downloadInvoiceDocument)(ref.url, { apiOrigin,
        extraOrigins: (process.env.XLEDGER_DOCUMENT_ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean) });
      doc.bytes = bytes.length; doc.sha256 = createHash("sha256").update(bytes).digest("hex");
    } catch (error) { doc.error = error instanceof Error ? error.message : "Document download failed"; continue; }
    const prefix = bytes.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "").trimStart();
    try {
      if (bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
        doc.mimeType = "application/pdf"; blobs.set(ref.dbId, bytes);
        doc.parsed = await (dependencies.pdf ?? readPdf)(bytes, invoice.currency || undefined);
      }
      else if (prefix.startsWith("<?xml") || /^<(?:[\w.-]+:)?(?:Invoice|CreditNote)(?:\s|>)/.test(prefix)) {
        doc.mimeType = "application/xml"; blobs.set(ref.dbId, bytes);
        doc.parsed = readEhf(bytes);
      }
      else { doc.status = "unsupported_format"; doc.error = "Xledger link did not return a PDF or UBL/EHF invoice (a sign-in page is not a document)"; continue; }
      const parsed = doc.parsed;
      if (parsed.invoiceNumber !== invoice.invoiceNumber || (parsed.invoiceDate && invoice.invoiceDate && parsed.invoiceDate !== invoice.invoiceDate) ||
          (parsed.currency && invoice.currency && parsed.currency !== invoice.currency)) {
        doc.status = "identity_mismatch"; doc.error = "Document invoice number, date or currency could not be matched exactly to the Xledger invoice"; continue;
      }
      doc.status = parsed.status;
    } catch (error) { doc.status = "parse_failed"; doc.error = error instanceof Error ? error.message : "Document could not be parsed"; }
  }
  const usable = result.documents.filter(d => d.status === "read" || d.status === "needs_review");
  usable.sort((a, b) => Number(b.status === "read") - Number(a.status === "read") || Number(b.parsed?.format === "ehf") - Number(a.parsed?.format === "ehf"));
  const selected = usable[0];
  result.selectedDocumentId = selected?.documentId ?? null;
  result.status = selected ? (selected.status === "read" ? "read" : "needs_review") : (result.documents.some(d => d.status === "identity_mismatch") ? "needs_review" : "failed");
  const verifiedTotals = usable.filter(d => d.status === "read" && d.parsed?.lineNetTotal != null).map(d => decimal(d.parsed!.lineNetTotal));
  if (verifiedTotals.some(total => total.minus(verifiedTotals[0]).abs().gt("0.02"))) {
    result.status = "needs_review";
    result.warnings.push("Original document candidates disagree on line net total; do not choose a price source until reviewed");
  }
  if (result.documents.some(d => d.error)) result.warnings.push("Some document candidates failed; inspect each document's status");
  if (selected?.parsed?.creditNote) result.warnings.push("Credit note: kept separate from ordinary purchase price observations");
  return { result, blobs };
}

/** Checkpoints contain lines/provenance, not signed links or full document text. */
export function checkpointRead(read: InvoiceRead): InvoiceRead {
  return { ...read, documents: read.documents.map(d => ({ ...d, parsed: d.parsed ? { ...d.parsed, text: "" } : undefined })) };
}
