import { vi } from "vitest";
import { connection } from "./invoice-fixtures.js";
const scalar = (name: string, type = "String") => ({ name, type: { kind: "SCALAR", name: type } });
const object = (name: string, type: string, args: any[] = []) => ({ name, type: { kind: "OBJECT", name: type }, args });

export function settlementBackend(options: {
  source?: string; cash?: boolean; sales?: boolean; headerOwner?: number; rowOwner?: number; docOwner?: number;
  primary?: boolean; attachments?: boolean; attachmentPages?: any[]; types?: Record<string, any>;
  failAttachments?: boolean; missingPrimaryField?: boolean; wrongPeriod?: boolean;
} = {}) {
  const file = { dbId: "100", ownerDbId: options.docOwner ?? 7, url: "https://www.xledger.net/Files2/synthetic.pdf?signature=private", fileName: "synthetic-daily-report.pdf" };
  const types: Record<string, any> = {
    TransactionHeader: { name: "TransactionHeader", fields: [object("invoiceFile", "Url"), object("attachments", "JournalAttachmentConnection", [scalar("first", "Int"), scalar("after")])] },
    Url: { name: "Url", fields: [scalar("dbId", "Int64String"), scalar("ownerDbId", "Int"), scalar("url"), scalar("fileName")] },
    JournalAttachmentConnection: { name: "JournalAttachmentConnection", fields: [object("pageInfo", "PageInfo"), object("edges", "JournalAttachmentEdge")] },
    JournalAttachmentEdge: { name: "JournalAttachmentEdge", fields: [scalar("cursor"), object("node", "JournalAttachment")] },
    JournalAttachment: { name: "JournalAttachment", fields: [scalar("dbId", "Int"), scalar("ownerDbId", "Int"), scalar("headerDbId", "Int"), object("file", "Url")] },
    ...options.types,
  };
  const header = { dbId: 90, ownerDbId: options.headerOwner ?? 7, transactionNumber: 25, fiscalYear: 2026,
    fiscalPeriod: 10, postedDate: "2026-10-02", transactionSource: { code: options.source || "AR" } };
  const rows = [
    { dbId: "1", account: { code: options.sales === false ? "4000" : "3000" }, amount: "-100.0000" },
    { dbId: "2", account: { code: options.cash === false ? "1920" : "1905" }, amount: "100.0000" },
  ].map(row => ({ ...row, ownerDbId: options.rowOwner ?? 7, periodId: options.wrongPeriod ? 88 : 99, headerDbId: 90, header }));
  const pages = options.attachmentPages || [connection("attachments", options.attachments ? [{ dbId: 11, ownerDbId: 7, headerDbId: 90, file }] : []).attachments];
  let pageNumber = 0;
  const run = vi.fn(async (query: string) => {
    if (query.includes("__type")) return Object.fromEntries([...query.matchAll(/(t\d+): __type\(name: "([^"]+)"\)/g)].map(m => [m[1], types[m[2]] ?? null]));
    if (query.includes("entities(")) return connection("entities", [{ dbId: 7 }]);
    if (query.includes("period(dbId:")) return { period: { dbId: 99, fiscalYear: 2026, fiscalPeriod: 10, fromDate: "2026-10-01", toDate: "2026-10-31" } };
    if (query.includes("transactions(")) {
      if (query.includes("attachments(first:")) {
        if (options.failAttachments) throw new Error("Synthetic JournalAttachment read permission denied");
        return connection("transactions", [{ ...rows[0], header: { ...header, attachments: pages[pageNumber++] } }]);
      }
      if (query.includes("invoiceFile {")) return connection("transactions", [{ ...rows[0], header: {
        ...header, ...(options.missingPrimaryField ? {} : { invoiceFile: options.primary ? file : null }),
      } }]);
      return connection("transactions", rows);
    }
    throw new Error("Unexpected synthetic query");
  });
  return { run, file, types, rows };
}
export const settlementRequest = { fiscalYear: 2026, periodNumber: 10, periodId: 99, headerDbId: 90 };

/** Synthetic daily report, without an invoice number or supplier line table. */
export function settlementPdf() {
  const lines = ["Synthetic Daily Settlement", "Report date: 2026-10-01", "Register: TEST-1", "Cash payments NOK 500.00",
    "Cash refunds NOK 20.00", "Opening float NOK 1000.00", "Closing cash NOK 1480.00", "Card payments NOK 2500.00"];
  const content = lines.map((text, i) => `BT /F1 10 Tf 40 ${760 - i * 20} Td (${text}) Tj ET`).join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
