import { describe, expect, it, vi } from "vitest";
import { inspectInvoiceRecordSources, readInvoiceLineRecords } from "../src/invoice-records.js";

// Synthetic contracts exercise runtime schema checks. They do not certify the
// live EInvoiceDetail field names, permissions, or original invoice semantics.
const scalar = (name: string, type = "String") => ({ name, type: { kind: "SCALAR", name: type } });
const object = (name: string, type: string) => ({ name, type: { kind: "OBJECT", name: type } });
const root = (name: string, type: string) => ({
  name, type: { kind: "OBJECT", name: type + "Connection" },
  args: [scalar("first", "Int"), scalar("after"), scalar("ownerSet", "OwnerSet"), scalar("filter", type + "_Filter")],
});

function backend(options: {
  nodeFields?: any[]; roots?: any[]; more?: boolean | null; next?: string;
  rows?: any[]; parentFilter?: any; recordError?: Error; missingConnection?: boolean; missingEdges?: boolean;
} = {}) {
  const readQueries: string[] = [];
  const run = vi.fn(async (query: string) => {
    if (query.includes("__schema")) return {
      __schema: { queryType: { fields: options.roots ?? [root("eInvoiceDetails", "EInvoiceDetail"), root("invoiceBaseItems", "InvoiceBaseItem")] } },
      n0: { name: "EInvoiceDetail", fields: options.nodeFields ?? [
        scalar("dbId", "Int64String"), scalar("ownerDbId", "Int"), scalar("quantity", "Float"),
        scalar("unitPrice", "MoneyString"), scalar("baseQuantity", "Float"),
        scalar("discountAmount", "MoneyString"), scalar("amount", "MoneyString"),
        object("unit", "Unit"), object("currency", "Currency"), object("eInvoice", "EInvoice"),
        object("employee", "Employee"), object("unrelatedDocuments", "Document"),
      ] },
      n1: null,
      n2: { name: "InvoiceBaseItem", fields: [scalar("dbId", "Int64String"), scalar("quantity", "Float"), scalar("unitPrice", "MoneyString")] },
    };
    if (query.includes("__type")) {
      const result: Record<string, any> = {};
      for (const match of query.matchAll(/(r\d+): __type\(name: "([^"]+)"\)/g)) {
        result[match[1]] = { name: match[2], fields: [scalar("dbId", "Int64String"), scalar("code"), scalar("invoiceNumber"), object("employee", "Employee")] };
      }
      if (query.includes("filter:")) result.filter = { inputFields: options.parentFilter ? [options.parentFilter] : [] };
      if (query.includes("f0:")) result.f0 = { inputFields: options.parentFilter ? [options.parentFilter] : [] };
      return result;
    }
    readQueries.push(query);
    if (options.recordError) throw options.recordError;
    if (options.missingConnection) return { eInvoiceDetails: null };
    const source = query.includes("invoiceBaseItems(") ? "invoiceBaseItems" : "eInvoiceDetails";
    return { [source]: {
      pageInfo: options.more === null ? null : { hasNextPage: options.more ?? false },
      edges: options.missingEdges ? undefined : (options.rows ?? [{ dbId: "9007199254740993", quantity: -2, unitPrice: "123.4500", baseQuantity: 100,
        discountAmount: "0.0000", amount: "-2.4690", unit: { code: "KG" }, currency: { code: "NOK" }, eInvoice: { dbId: "111", invoiceNumber: "SYNTHETIC-CREDIT" } }])
        .map(node => ({ node, ...(options.next !== undefined ? { cursor: options.next } : {}) })),
    } };
  });
  return { run, readQueries };
}

describe("bounded invoice records", () => {
  it("preserves exact source amounts, credit quantities, zero discounts and price basis without calculating a unit price", async () => {
    const { run, readQueries } = backend();
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 });
    expect(result.items[0]).toMatchObject({ dbId: "9007199254740993", quantity: -2, unitPrice: "123.4500", baseQuantity: 100, discountAmount: "0.0000" });
    expect(result).toMatchObject({ complete: true, ownerScope: "CURRENT", normalizedUnitPrice: null, originalSupplierProductLinesVerified: false });
    expect(readQueries).toHaveLength(1);
    expect(readQueries[0]).toContain("first: 1, ownerSet: CURRENT");
    expect(readQueries[0]).not.toMatch(/employee|unrelatedDocuments|mutation/);
    expect(result.selectedRelations.map(field => field.name)).toEqual(["unit", "currency", "eInvoice"]);
  });

  it("does not invent missing quantity or unit-price fields", async () => {
    const { run } = backend({ nodeFields: [scalar("dbId", "Int64String")], rows: [{ dbId: "1" }] });
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 });
    expect(result.items).toEqual([{ dbId: "1" }]);
    expect(result.warnings.join(" ")).toContain("missing quantities are not zero");
    expect(result.warnings.join(" ")).toContain("missing prices are not zero");
  });

  it("keeps null field values rather than substituting zero", async () => {
    const { run } = backend({ rows: [{ dbId: "1", quantity: null, unitPrice: null }] });
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 });
    expect(result.items[0]).toMatchObject({ quantity: null, unitPrice: null });
  });

  it("returns a usable cursor but never calls a limited page complete", async () => {
    const { run } = backend({ more: true, next: 'cursor"\\next' });
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 });
    expect(result).toMatchObject({ complete: false, sourceComplete: false, hasMore: true, nextCursor: 'cursor"\\next' });
  });

  it("quotes cursors safely and marks the final continuation page incomplete as a full data source", async () => {
    const { run, readQueries } = backend();
    const after = 'cursor" injected: { quantity }';
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1, after });
    expect(readQueries[0]).toContain(`after: ${JSON.stringify(after)}`);
    expect(result).toMatchObject({ isContinuation: true, complete: false, sourceComplete: false, hasMore: false });
  });

  it("does not repeat an unusable cursor", async () => {
    const { run } = backend({ more: true, next: "same" });
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1, after: "same" });
    expect(result.nextCursor).toBeNull();
    expect(result.warnings.join(" ")).toContain("no usable continuation cursor");
  });

  it("does not return an empty cursor as a usable next page", async () => {
    const { run } = backend({ more: true, next: "" });
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 });
    expect(result.nextCursor).toBeNull();
    expect(result.complete).toBe(false);
  });

  it("rejects missing edges instead of reporting a complete empty source", async () => {
    const { run } = backend({ missingEdges: true });
    await expect(readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 })).rejects.toThrow("edges are missing");
  });

  it.each([{ more: null }, { missingConnection: true }])("does not certify an incomplete upstream response", async (options) => {
    const { run } = backend(options);
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 });
    expect(result.complete).toBe(false);
    expect(result.hasMore).toBeNull();
  });

  it("does not equate an empty accepted query with verified row access", async () => {
    const { run } = backend({ rows: [] });
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 });
    expect(result.recordReadPermission).toContain("row_access_not_verified");
    expect(result.originalSupplierProductLinesVerified).toBe(false);
  });

  it("preserves a permission failure without trying a different source", async () => {
    const { run, readQueries } = backend({ recordError: new Error("No EInvoiceDetail read permission") });
    await expect(readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 })).rejects.toThrow("No EInvoiceDetail read permission");
    expect(readQueries).toHaveLength(1);
  });

  it("does not perform an unfiltered fallback when the parent filter is unsupported", async () => {
    const { run, readQueries } = backend();
    await expect(readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1, invoiceDbId: "111" })).rejects.toThrow("no unfiltered fallback");
    expect(readQueries).toHaveLength(0);
  });

  it("uses only a schema-confirmed parent filter and preserves large source IDs", async () => {
    const { run, readQueries } = backend({ parentFilter: scalar("eInvoiceDbId", "Int64String") });
    const result = await readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1, invoiceDbId: "9007199254740993" });
    expect(readQueries[0]).toContain('filter: { eInvoiceDbId: "9007199254740993" }');
    expect(result.parentFilter?.dbId).toBe("9007199254740993");
  });

  it("refuses a source that cannot be scoped to CURRENT", async () => {
    const unscoped = root("eInvoiceDetails", "EInvoiceDetail");
    unscoped.args = unscoped.args.filter(field => field.name !== "ownerSet");
    const { run, readQueries } = backend({ roots: [unscoped] });
    await expect(readInvoiceLineRecords(run, { source: "eInvoiceDetails", first: 1 })).rejects.toThrow("CURRENT owner scope");
    expect(readQueries).toHaveLength(0);
  });

  it("labels sales invoice basis as a separate source rather than supplier purchases", async () => {
    const { run } = backend();
    const result = await readInvoiceLineRecords(run, { source: "invoiceBaseItems", first: 1 });
    expect(result.sourceKind).toBe("sales_invoice_basis");
    expect(result.originalSupplierProductLinesVerified).toBe(false);
  });

  it("introspects available fields without claiming record permissions", async () => {
    const { run, readQueries } = backend();
    const result = await inspectInvoiceRecordSources(run);
    expect(result[0]).toMatchObject({ source: "eInvoiceDetails", foundInQuery: true, foundInSchema: true, recordReadPermissionsVerified: false });
    expect(readQueries).toHaveLength(0);
  });

  it.each([
    { source: "journalEntries", first: 1 }, { source: "eInvoiceDetails", first: 51 },
    { source: "eInvoiceDetails", first: 1, invoiceDbId: '1" injected' },
  ])("rejects invalid input before inspecting or querying data", async (options) => {
    const { run } = backend();
    await expect(readInvoiceLineRecords(run, options as any)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
});
