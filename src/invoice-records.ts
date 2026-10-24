import type { GqlRunner } from "./graphql.js";

// These query/type pairs were observed in the authenticated demo schema on
// 2026-10-24. They are not inferred from the plural of a type name.
export const INVOICE_RECORD_SOURCES = ["eInvoiceDetails", "vendorInvoiceDetails", "invoiceBaseItems"] as const;
export type InvoiceRecordSource = typeof INVOICE_RECORD_SOURCES[number];
const SOURCES = {
  eInvoiceDetails: { node: "EInvoiceDetail", parentFilter: "eInvoiceDbId", kind: "electronic_invoice_detail" },
  vendorInvoiceDetails: { node: "VendorInvoiceDetail", parentFilter: "vendorInvoiceDbId", kind: "supplier_invoice_detail" },
  invoiceBaseItems: { node: "InvoiceBaseItem", parentFilter: "salesOrderHeaderDbId", kind: "sales_invoice_basis" },
} as const;

type TypeRef = { kind?: string; name?: string | null; ofType?: TypeRef | null } | null | undefined;
type Field = { name: string; description?: string | null; type?: TypeRef; args?: Field[] };
type SchemaType = { name?: string; fields?: Field[] | null; inputFields?: Field[] | null } | null | undefined;
const TYPE = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
const FIELDS = `name description type { ${TYPE} } args { name type { ${TYPE} } }`;
const INPUT_FIELDS = `name description type { ${TYPE} }`;
const SCALAR_FIELDS = new Set([
  "dbId", "ownerDbId", "invoiceNumber", "invoiceDate", "transactionDate", "orderNumber",
  "lineNo", "lineNumber", "text", "description", "quantity", "invoicedQuantity",
  "originalQuantity", "unitPrice", "price", "priceAmount", "baseQuantity", "priceBaseQuantity",
  "unit", "unitCode", "unitOfMeasure", "currencyCode", "invoiceAmount", "netAmount", "lineExtensionAmount",
  "amount", "taxAmount", "taxPercent", "discount", "discountAmount", "discountPercent",
  "extProductNumber", "productNumber", "eInvoiceDbId", "vendorInvoiceDbId",
  "salesOrderHeaderDbId", "salesOrderDetailDbId",
]);
const RELATIONS = new Set(["eInvoice", "vendorInvoice", "product", "unit", "currency"]);
const RELATED_SCALARS = new Set([
  ...SCALAR_FIELDS, "code", "name", "isoCode", "supplierDbId", "subledgerDbId", "companyDbId",
]);

function base(type: TypeRef): TypeRef {
  if (type?.kind === "NON_NULL" || type?.kind === "LIST") return base(type.ofType);
  return type;
}
function label(type: TypeRef): string {
  if (!type) return "unknown";
  if (type.kind === "NON_NULL") return `${label(type.ofType)}!`;
  if (type.kind === "LIST") return `[${label(type.ofType)}]`;
  return type.name || "unknown";
}
function fields(type: SchemaType): Field[] { return type?.fields || []; }
function scalar(field: Field): boolean {
  // Lists and fields requiring arguments must not be selected as scalars.
  let ref = field.type;
  while (ref?.kind === "NON_NULL") ref = ref.ofType;
  return Boolean(ref && ["SCALAR", "ENUM"].includes(ref.kind || "") && !field.args?.some(arg => arg.type?.kind === "NON_NULL"));
}
function describe(field: Field) { return { name: field.name, type: label(field.type), description: field.description || null }; }

async function inspectSources(run: GqlRunner) {
  const data = await run(`{
    __schema { queryType { fields { name type { ${TYPE} } args { name type { ${TYPE} } } } } }
    ${INVOICE_RECORD_SOURCES.map((source, i) => `n${i}: __type(name: ${JSON.stringify(SOURCES[source].node)}) { name fields { ${FIELDS} } }`).join("\n")}
  }`);
  const roots: Field[] = data.__schema?.queryType?.fields || [];
  return INVOICE_RECORD_SOURCES.map((source, i) => ({
    source, config: SOURCES[source], root: roots.find(field => field.name === source),
    node: data[`n${i}`] as SchemaType,
  }));
}

/** Metadata only; included in the existing capability tool after deployment. */
export async function inspectInvoiceRecordSources(run: GqlRunner) {
  const sources = await inspectSources(run);
  const filterNames = [...new Set(sources.flatMap(({ root }) => {
    const name = base(root?.args?.find(arg => arg.name === "filter")?.type)?.name;
    return name ? [name] : [];
  }))];
  const filters = filterNames.length ? await run(`{ ${filterNames.map((name, i) => `f${i}: __type(name: ${JSON.stringify(name)}) { name inputFields { ${INPUT_FIELDS} } }`).join(" ")} }`) : {};
  return sources.map(({ source, config, root, node }) => {
    const filterName = base(root?.args?.find(arg => arg.name === "filter")?.type)?.name;
    const filterType = filterName ? filters[`f${filterNames.indexOf(filterName)}`] as SchemaType : null;
    return {
      source, nodeType: config.node, sourceKind: config.kind,
      foundInQuery: Boolean(root), foundInSchema: Boolean(node),
      fields: fields(node).map(describe),
      filterType: filterName || null, filterFields: (filterType?.inputFields || []).map(describe),
      recordReadPermissionsVerified: false,
    };
  });
}

export async function readInvoiceLineRecords(run: GqlRunner, options: {
  source: InvoiceRecordSource; first: number; after?: string; invoiceDbId?: string;
}) {
  const config = SOURCES[options.source];
  if (!INVOICE_RECORD_SOURCES.includes(options.source) || !config || !Number.isInteger(options.first) || options.first < 1 || options.first > 50) throw new Error("Invalid invoice record source or page size");
  if (options.invoiceDbId !== undefined && !/^[1-9]\d{0,18}$/.test(options.invoiceDbId)) throw new Error("invoiceDbId must be a positive source-header ID");
  if (options.after !== undefined && (options.after.length < 1 || options.after.length > 2000)) throw new Error("Invalid continuation cursor");

  const source = (await inspectSources(run)).find(item => item.source === options.source)!;
  if (base(source.root?.type)?.name !== `${config.node}Connection` || !source.node) throw new Error(`The current schema does not expose the verified ${options.source} connection`);
  const argNames = new Set(source.root?.args?.map(arg => arg.name));
  if (!["first", "after", "ownerSet"].every(name => argNames.has(name))) throw new Error("The source cannot be read with the required bounded pagination and CURRENT owner scope");
  const scalarFields = fields(source.node).filter(field => SCALAR_FIELDS.has(field.name) && scalar(field));
  if (!scalarFields.some(field => field.name === "dbId")) throw new Error("The source has no supported record identity field");
  const relations = fields(source.node).filter(field => RELATIONS.has(field.name) && base(field.type)?.kind === "OBJECT" && !field.args?.some(arg => arg.type?.kind === "NON_NULL"));
  // Do not follow lists or arbitrary relationships, even if their element type
  // happens to match an allowed relation. This reader is intentionally shallow.
  const singularRelations = relations.filter(field => {
    let ref = field.type;
    while (ref?.kind === "NON_NULL") ref = ref.ofType;
    return ref?.kind === "OBJECT";
  });
  const relatedNames = [...new Set(singularRelations.map(field => base(field.type)!.name!))];
  const filterName = options.invoiceDbId ? base(source.root?.args?.find(arg => arg.name === "filter")?.type)?.name : null;
  if (options.invoiceDbId && !filterName) throw new Error("The source has no invoice filter; an AP transaction ID must not be substituted for a source-header ID");
  const related = relatedNames.length || filterName ? await run(`{
    ${relatedNames.map((name, i) => `r${i}: __type(name: ${JSON.stringify(name)}) { name fields { ${FIELDS} } }`).join("\n")}
    ${filterName ? `filter: __type(name: ${JSON.stringify(filterName)}) { inputFields { ${INPUT_FIELDS} } }` : ""}
  }`) : {};
  const nested = singularRelations.flatMap(field => {
    const type = related[`r${relatedNames.indexOf(base(field.type)!.name!)}`] as SchemaType;
    const selected = fields(type).filter(child => RELATED_SCALARS.has(child.name) && scalar(child));
    return selected.length ? [{ name: field.name, fields: selected }] : [];
  });
  let filter = "";
  if (options.invoiceDbId) {
    const field = (related.filter?.inputFields as Field[] | undefined)?.find(field => field.name === config.parentFilter);
    const typeName = base(field?.type)?.name;
    if (!field || !scalar(field) || !["Int", "Int64String", "ID"].includes(typeName || "")) throw new Error(`The schema does not confirm ${config.parentFilter} as a supported parent ID filter; no unfiltered fallback was performed`);
    if (typeName === "Int" && BigInt(options.invoiceDbId) > 2147483647n) throw new Error("Source-header ID exceeds the filter's Int range");
    filter = `, filter: { ${config.parentFilter}: ${typeName === "Int" ? options.invoiceDbId : JSON.stringify(options.invoiceDbId)} }`;
  }
  const selection = [...scalarFields.map(field => field.name), ...nested.map(field => `${field.name} { ${field.fields.map(child => child.name).join(" ")} }`)].join("\n");
  const data = await run(`{ ${options.source}(first: ${options.first}, ownerSet: CURRENT${options.after ? `, after: ${JSON.stringify(options.after)}` : ""}${filter}) {
    pageInfo { hasNextPage } edges { cursor node { ${selection} } }
  } }`);
  const connection = data[options.source];
  if (connection && connection.edges !== null && !Array.isArray(connection.edges)) throw new Error("Xledger returned an invalid invoice record page: edges are missing or malformed");
  const edges: Array<{ cursor?: string; node?: Record<string, unknown> }> = connection?.edges || [];
  if (!Array.isArray(edges) || edges.length > options.first || edges.some(edge => !edge.node || typeof edge.node !== "object" || edge.node.dbId == null)) throw new Error("Xledger returned an invalid invoice record page");
  const hasMore = typeof connection?.pageInfo?.hasNextPage === "boolean" ? connection.pageInfo.hasNextPage as boolean : null;
  const lastCursor = edges.at(-1)?.cursor;
  const nextCursor = hasMore && typeof lastCursor === "string" && lastCursor.length > 0 && lastCursor !== options.after ? lastCursor : null;
  const complete = Boolean(connection) && hasMore === false && !options.after;
  const warnings = ["Raw structured records are not yet reconciled against original supplier invoices. Quantities, prices, units, discounts and price bases retain their source field names; no price per kilogram is inferred."];
  if (!complete) warnings.push("This page is not the complete source. Continue with nextCursor when available; do not calculate full-period totals from this page.");
  if (hasMore && !nextCursor) warnings.push("More records are reported, but no usable continuation cursor was returned.");
  if (!scalarFields.some(field => ["quantity", "invoicedQuantity"].includes(field.name))) warnings.push("No supported quantity field was found; missing quantities are not zero.");
  if (!scalarFields.some(field => ["unitPrice", "price", "priceAmount"].includes(field.name))) warnings.push("No supported unit-price field was found; missing prices are not zero.");
  return {
    source: options.source, sourceKind: config.kind, nodeType: config.node, ownerScope: "CURRENT",
    items: edges.map(edge => edge.node), returned: edges.length,
    complete, sourceComplete: complete, hasMore, nextCursor,
    isContinuation: Boolean(options.after),
    parentFilter: options.invoiceDbId ? { field: config.parentFilter, dbId: options.invoiceDbId } : null,
    selectedFields: scalarFields.map(describe), selectedRelations: nested.map(field => ({ name: field.name, fields: field.fields.map(describe) })),
    recordReadPermission: edges.length ? "succeeded_for_returned_records" : "accepted_without_records; row_access_not_verified",
    originalSupplierProductLinesVerified: false, documentExtractionImplemented: false,
    normalizedUnitPrice: null, warnings,
  };
}
