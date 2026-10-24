import type { GqlRunner } from "./graphql.js";

// These names come from Xledger's documentation. Only introspection is issued
// here: do not invent a connection, filter or document endpoint from a type name.
const TYPES = ["SalesOrderDetail", "InvoiceBaseItem", "PurchaseOrderDetail", "ApTransaction"] as const;

function typeLabel(type: any): string {
  if (!type) return "unknown";
  if (type.kind === "NON_NULL") return `${typeLabel(type.ofType)}!`;
  if (type.kind === "LIST") return `[${typeLabel(type.ofType)}]`;
  return type.name || "unknown";
}

export async function inspectInvoiceLineCapabilities(run: GqlRunner) {
  const fields = "name type { kind name ofType { kind name ofType { kind name } } }";
  const query = `{ ${TYPES.map((name, i) => `t${i}: __type(name: "${name}") { name fields { ${fields} } }`).join(" ")} }`;
  const data = await run(query);
  return {
    lineReadingImplemented: false,
    supplierInvoiceLinesVerified: false,
    documentExtractionImplemented: false,
    recordReadPermissionsVerified: false,
    sources: TYPES.map((typeName, i) => {
      const type = data[`t${i}`];
      const names: string[] = (type?.fields || []).map((f: { name: string }) => f.name);
      return {
        typeName,
        foundInSchema: Boolean(type),
        hasQuantity: names.includes("quantity"),
        hasUnitPrice: names.includes("unitPrice"),
        fieldNames: names,
        fields: (type?.fields || []).map((field: any) => ({ name: field.name, type: typeLabel(field.type) })),
      };
    }),
    nextStep: "Verify the read connection and invoice/owner relationship in this schema, then request only the corresponding read permissions. For received supplier invoices, verify original EHF/PDF access separately if structured invoice lines are absent. Do not infer quantities or unit prices from invoice totals.",
    permissionNote: "A type appearing in introspection does not establish that this token can read its records.",
  };
}
