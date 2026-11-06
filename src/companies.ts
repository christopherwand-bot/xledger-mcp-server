import { createGraphqlClient, type GqlRunner } from "./graphql.js";

export const COMPANY_IDS = ["kraftgutta", "kraft_pizzeria", "kraft_pizzeria_honefoss", "kraft_pizzeria_kongsberg", "speti"] as const;
export type CompanyId = typeof COMPANY_IDS[number];
const definitions = [
  { id: "kraftgutta", name: "Kraftgutta AS", variable: "XLEDGER_GRAPHQL_TOKEN" },
  { id: "kraft_pizzeria", name: "Kraft Pizzeria AS", variable: "XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA" },
  { id: "kraft_pizzeria_honefoss", name: "Kraft Pizzeria Hønefoss AS", variable: "XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA_HONEFOSS" },
  { id: "kraft_pizzeria_kongsberg", name: "Kraft Pizzeria Kongsberg AS", variable: "XLEDGER_GRAPHQL_TOKEN_KRAFT_PIZZERIA_KONGSBERG" },
  { id: "speti", name: "Speti AS", variable: "XLEDGER_GRAPHQL_TOKEN_SPETI" },
] as const;
export interface CompanyIdentity { id: CompanyId; name: string; ownerDbId: number }
export interface CompanyContext { company: CompanyIdentity; run: GqlRunner }
type ClientFactory = (options: { url: string; token: string }) => GqlRunner;
const normalizeName = (name: string) => name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

// Only top-level business records are checked. Referenced account/currency and
// other shared master data can legitimately belong higher in Xledger's tree.
const ownedRoots = new Set([
  "accountBalances", "budgetBalances", "transactions", "journalEntries", "apTransactions", "arTransactions",
  "vendorInvoices", "vendorInvoiceDetails", "eInvoiceDetails", "invoiceBaseItems", "salesOrders",
  "cashBookTransactions", "customers", "projects", "timesheets", "employees", "expenseDetails", "expenseBases",
  "arTransaction_deltas", "apTransaction_deltas", "timesheet_deltas", "project_deltas", "employee_deltas", "account_deltas",
]);
function checkOwners(data: Record<string, any>, owner: number, query: string) {
  for (const root of ownedRoots) {
    if (new RegExp(`\\b${root}\\s*\\(`).test(query) && !(root in data))
      throw new Error(`Missing ${root} source; company scope could not be verified`);
  }
  for (const [root, connection] of Object.entries(data)) {
    if (!ownedRoots.has(root)) continue;
    if (!connection || !(Array.isArray(connection.edges) || connection.edges === null))
      throw new Error(`Invalid or inaccessible ${root} source; company scope could not be verified`);
    for (const edge of connection.edges || []) {
      if (!edge?.node || edge.node.ownerDbId !== owner)
        throw new Error(`${root} company ownership mismatch; records were not returned`);
    }
  }
}

/** Immutable clients per company. No request changes process.env or a global
 * current-company value; background scans retain their own verified client. */
export class CompanyRegistry {
  readonly url: string;
  private entries = new Map<CompanyId, { raw: GqlRunner; verified?: Promise<CompanyContext>; identity?: CompanyIdentity }>();
  constructor(env: NodeJS.ProcessEnv = process.env, factory: ClientFactory = createGraphqlClient) {
    this.url = env.XLEDGER_API_URL || "https://www.xledger.net/graphql";
    for (const definition of definitions) {
      const token = env[definition.variable]?.trim();
      if (token) this.entries.set(definition.id, { raw: factory({ url: this.url, token }) });
    }
  }
  get selectionRequired() { return this.entries.size > 1; }
  list() {
    return definitions.map(d => ({ id: d.id, name: d.name, configured: this.entries.has(d.id),
      identityVerified: Boolean(this.entries.get(d.id)?.identity),
      ownerDbId: this.entries.get(d.id)?.identity?.ownerDbId ?? null }));
  }
  resolve(id?: string): CompanyId {
    if (!id && this.selectionRequired) throw new Error("Select company explicitly. Use list_companies; no company was selected automatically.");
    const selected = id || this.entries.keys().next().value;
    if (!selected || !COMPANY_IDS.includes(selected as CompanyId) || !this.entries.has(selected as CompanyId))
      throw new Error("Unknown or unconfigured company; use list_companies");
    return selected as CompanyId;
  }
  async verify(id: string): Promise<CompanyContext> {
    const selected = this.resolve(id), entry = this.entries.get(selected)!;
    if (!entry.verified) entry.verified = (async () => {
      const data = await entry.raw("{ entities(first: 2, ownerSet: CURRENT) { edges { node { dbId description } } } }");
      const rows = data.entities?.edges;
      const node = Array.isArray(rows) && rows.length === 1 ? rows[0]?.node : undefined;
      const definition = definitions.find(d => d.id === selected)!;
      if (!node || !Number.isSafeInteger(node.dbId) || node.dbId < 1 || typeof node.description !== "string" ||
          normalizeName(node.description) !== normalizeName(definition.name))
        throw new Error(`API token identity does not match ${definition.name}; company access was blocked`);
      const company: CompanyIdentity = { id: selected, name: node.description, ownerDbId: node.dbId };
      const run: GqlRunner = async query => {
        const result = await entry.raw(query);
        checkOwners(result, company.ownerDbId, query);
        if (result.entities && (result.entities.edges?.length !== 1 || result.entities.edges[0]?.node?.dbId !== company.ownerDbId))
          throw new Error("CURRENT entity changed; company access was blocked");
        return result;
      };
      entry.identity = company;
      return { company, run };
    })().catch(error => { entry.verified = undefined; throw error; });
    return entry.verified;
  }
  async probe(id: string) {
    const current = await this.verify(id);
    const results: Record<string, { status: string; sampleRows?: number; recordOwnershipVerified?: boolean; error?: string }> = {};
    for (const source of ["accountBalances", "apTransactions"]) {
      try {
        const data = await current.run(`{ ${source}(first: 1, ownerSet: CURRENT, filter: { ownerDbId: ${current.company.ownerDbId} }) { edges { node { dbId ownerDbId } } } }`);
        const count = data[source].edges?.length || 0;
        results[source] = { status: count ? "readable" : "accepted_without_rows", sampleRows: count, recordOwnershipVerified: count > 0 };
      } catch (error) {
        results[source] = { status: "failed", error: error instanceof Error ? error.message : "Read-access probe failed" };
      }
    }
    return results;
  }
  async inspect(checkReadAccess = false) {
    const inspectOne = async (item: ReturnType<CompanyRegistry["list"]>[number]) => {
      if (!item.configured) return { ...item, status: "not_configured" };
      try { const context = await this.verify(item.id); return { ...item, ...context.company, identityVerified: true, status: "verified",
        ...(checkReadAccess ? { readAccess: await this.probe(item.id) } : {}) }; }
      catch (error) { return { ...item, identityVerified: false, status: "failed", error: error instanceof Error ? error.message : "Company verification failed" }; }
    };
    const results = [], items = this.list();
    // Bound concurrent preflight requests while avoiding five serial timeouts.
    for (let i = 0; i < items.length; i += 2) {
      results.push(...await Promise.all(items.slice(i, i + 2).map(inspectOne)));
    }
    return results;
  }
}

let shared: CompanyRegistry | undefined;
export function configuredCompanies() { return shared ??= new CompanyRegistry(); }
