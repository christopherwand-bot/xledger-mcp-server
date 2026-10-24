import type { GqlRunner } from "./graphql.js";

// These names come from Xledger's documentation. Only introspection is issued
// here: do not invent a connection, filter or document endpoint from a type name.
const TYPES = ["SalesOrderDetail", "InvoiceBaseItem", "PurchaseOrderDetail", "ApTransaction"] as const;
const ROOT_NAME_PATTERN = /(invoice|order|purchase|supplier|sales|\bap\b)/i;
const MAX_ROOT_CANDIDATES = 40;

type IntrospectionType = { kind?: string; name?: string | null; ofType?: IntrospectionType | null } | null | undefined;
type IntrospectionField = { name: string; type?: IntrospectionType; args?: Array<{ name: string; type?: IntrospectionType }> };

function typeLabel(type: IntrospectionType): string {
  if (!type) return "unknown";
  if (type.kind === "NON_NULL") return `${typeLabel(type.ofType)}!`;
  if (type.kind === "LIST") return `[${typeLabel(type.ofType)}]`;
  return type.name || "unknown";
}

function baseTypeName(type: IntrospectionType): string | null {
  if (!type) return null;
  if (type.kind === "NON_NULL" || type.kind === "LIST") return baseTypeName(type.ofType);
  return type.name || null;
}

const TYPE_SELECTION = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
const FIELD_SELECTION = `name type { ${TYPE_SELECTION} }`;
const ROOT_FIELD_SELECTION = `name args { name type { ${TYPE_SELECTION} } } type { ${TYPE_SELECTION} }`;

function aliasesForTypes(typeNames: string[]) {
  return typeNames.map((name, i) => `t${i}: __type(name: ${JSON.stringify(name)}) { name fields { ${FIELD_SELECTION} } }`).join(" ");
}

function fieldsOf(value: any): IntrospectionField[] {
  return Array.isArray(value?.fields) ? value.fields : [];
}

export async function inspectInvoiceLineCapabilities(run: GqlRunner) {
  const query = `{ ${TYPES.map((name, i) => `t${i}: __type(name: "${name}") { name fields { ${FIELD_SELECTION} } }`).join(" ")} }`;
  const data = await run(query);
  return {
    lineReadingImplemented: false,
    supplierInvoiceLinesVerified: false,
    documentExtractionImplemented: false,
    recordReadPermissionsVerified: false,
    sources: TYPES.map((typeName, i) => {
      const type = data[`t${i}`];
      const names: string[] = fieldsOf(type).map((f) => f.name);
      return {
        typeName,
        foundInSchema: Boolean(type),
        hasQuantity: names.includes("quantity"),
        hasUnitPrice: names.includes("unitPrice"),
        fieldNames: names,
        fields: fieldsOf(type).map((field) => ({ name: field.name, type: typeLabel(field.type) })),
      };
    }),
    nextStep: "Verify the read connection and invoice/owner relationship in this schema, then request only the corresponding read permissions. For received supplier invoices, verify original EHF/PDF access separately if structured invoice lines are absent. Do not infer quantities or unit prices from invoice totals.",
    permissionNote: "A type appearing in introspection does not establish that this token can read its records.",
  };
}

/**
 * Finds GraphQL query paths that may lead to known invoice/order line types.
 * It does not query business records, and discovery alone proves neither record
 * permission nor that a purchase-order line is an received supplier invoice line.
 */
export async function discoverInvoiceLineReadPaths(run: GqlRunner) {
  const schema = await run(`{ __schema { queryType { name fields { ${ROOT_FIELD_SELECTION} } } } }`);
  const rootFields: IntrospectionField[] = schema?.__schema?.queryType?.fields || [];
  const candidates = rootFields
    .filter((field) => ROOT_NAME_PATTERN.test(field.name))
    .slice(0, MAX_ROOT_CANDIDATES)
    .map((field) => ({ field, resultType: baseTypeName(field.type) }))
    .filter((candidate): candidate is { field: IntrospectionField; resultType: string } => Boolean(candidate.resultType));

  const connectionTypes = [...new Set(candidates.map((candidate) => candidate.resultType))];
  const connections = connectionTypes.length ? await run(`{ ${aliasesForTypes(connectionTypes)} }`) : {};
  const edgeTypeNames = [...new Set(connectionTypes.flatMap((_, i) => {
    const connection = connections[`t${i}`];
    return fieldsOf(connection)
      .filter((field) => field.name === "edges")
      .map((field) => baseTypeName(field.type))
      .filter((name): name is string => Boolean(name));
  }))];
  const edges = edgeTypeNames.length ? await run(`{ ${aliasesForTypes(edgeTypeNames)} }`) : {};

  const paths = candidates.map((candidate) => {
    const connectionIndex = connectionTypes.indexOf(candidate.resultType);
    const connection = connections[`t${connectionIndex}`];
    const edgeType = fieldsOf(connection).find((field) => field.name === "edges");
    const edgeTypeName = baseTypeName(edgeType?.type);
    const edgeIndex = edgeTypeName ? edgeTypeNames.indexOf(edgeTypeName) : -1;
    const edge = edgeIndex >= 0 ? edges[`t${edgeIndex}`] : null;
    const nodeTypeName = baseTypeName(fieldsOf(edge).find((field) => field.name === "node")?.type);
    return {
      rootField: candidate.field.name,
      arguments: (candidate.field.args || []).map((arg) => ({ name: arg.name, type: typeLabel(arg.type) })),
      resultType: candidate.resultType,
      connectionShape: {
        hasEdges: Boolean(edgeTypeName),
        edgeType: edgeTypeName,
        nodeType: nodeTypeName,
      },
      leadsToKnownLineType: nodeTypeName ? (TYPES as readonly string[]).includes(nodeTypeName) : false,
    };
  });

  return {
    recordReadingImplemented: false,
    recordReadPermissionsVerified: false,
    inspectedQueryFieldCount: rootFields.length,
    candidateCount: candidates.length,
    paths,
    nextStep: "Choose only a path whose node type is verified as a line type, then test one minimal read against a known invoice or order. Confirm owner/invoice linkage and record permission before exposing a line-reading tool.",
    permissionNote: "This is schema discovery only. It does not retrieve invoice data and does not prove that the token can read any returned path.",
  };
}
