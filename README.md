# Xledger MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that provides read-only access to the [Xledger](https://www.xledger.com) accounting system via its GraphQL API.

Use it with Claude, VS Code Copilot, or any MCP-compatible AI assistant to query your financial data: invoices, account balances, budget vs actual, projects, timesheets, invoice proposals, expenses and more.

## Features

- 17 read-only financial and diagnostic tools enabled by default; 6 personnel/employee-expense tools require explicit opt-in
- Compatible with Xledger GraphQL API v2 (cursor pagination, v2 filter syntax)
- OAuth 2.1 protection for remote ChatGPT connections; legacy bearer protection for non-web clients
- GDPR Art. 9 guard on absence project and time-type names in `get_absences`, `get_timesheets`, `get_consultant_profitability`, `get_expenses` and `get_journal_entries`: no per-person health absence by default. Some fields are not covered; see [Not covered](#not-covered)
- MCP SDK and `jose` for OAuth token verification
- TypeScript with full type safety

## Financial pilot changes (1.2.0)

This release implements the demo-test findings. See [pilot readiness and access request](docs/pilot-readiness.md) for the rollout sequence and remaining external work.

- Open AR/AP filters include nonzero balances of either sign, including credit balances.
- Financial row selections return explicit completeness/limit metadata. A short or capped list is not a verified total.
- The legacy-named `get_revenue_summary` is now an AR transaction overview. It excludes unnumbered rows, separates currencies and no longer labels transaction sums as invoiced revenue. `invoiceClassificationVerified` remains false until transaction type is verified. Use GL balances for accounting revenue.
- Missing budget rows produce `budget: null` and `variance: null`; a recorded zero budget remains zero.
- Dates must exist in the calendar; reversed intervals, invalid periods and invalid limits are rejected.
- GL year filtering happens before the output limit. Project and free-text fields are omitted by default; `includeProject=true` requires Project read access.
- Cash-book errors never cause a switch from row-creation date to bank date.
- Personnel/employee-expense tools are off by default. Static bearer fallback is off when OAuth is configured unless explicitly enabled for migration.
- Read requests have per-attempt deadlines and at most one retry for transient upstream/network failures.

Financial list payloads now contain `items`, `returned`, `matchedFetched`, `sourceComplete`, `complete`, and `hasMore`. Budget output keeps `rows`; customer lookup keeps `customers`. Consumers must check completeness before calculating totals.

## Structured invoice records (1.3.0)

`get_invoice_line_records` reads a bounded page from the schema-verified `eInvoiceDetails`, `vendorInvoiceDetails`, or `invoiceBaseItems` connection. It defaults to one record, scopes the query to `CURRENT`, checks available fields at runtime and preserves source values and field names. `invoiceBaseItems` is sales invoice basis, not supplier purchases.

In 1.3.1, the default query selects only scalar financial fields, including the actual electronic-invoice names `externalProduct`, `externalProductNumber`, `unitPriceAmount`, `unitPriceFactor`, `discountPct` and `taxPct`. Unit, currency and header reference objects require explicit `includeReferences: true`; these may need extra read permissions. The Product master is never selected. This corrects a live pilot failure where an optional Product lookup prevented reading the invoice detail itself. Existing calls with only `source` and `first` use the corrected default without a tool-metadata reload; reload is needed to expose the new optional parameter.

This is a record reader, not a certified supplier price analysis: the detail fields and token's record permissions still require live validation, and the records have not been reconciled with original supplier invoices. No EHF/PDF extraction, unit conversion or inferred price per kilogram is implemented. The existing capability tool now also reports the actual fields and filters of these three sources.

## Tools

| Tool | Description |
|------|-------------|
| `get_connection_info` | Configured endpoint, environment, current entity and pilot restrictions; no secrets |
| `get_invoice_line_capabilities` | Read-only schema discovery for invoice-line implementation; does not fetch invoice lines |
| `discover_invoice_line_read_paths` | Read-only discovery of actual query roots, connections and node types |
| `get_invoice_line_records` | One page of raw, schema-checked electronic/vendor invoice details or sales invoice basis; defaults to one record |
| `get_ar_transactions` | Customer invoices (Accounts Receivable): filter by date, outstanding only |
| `get_ap_transactions` | Supplier invoices (Accounts Payable): filter by date, outstanding only |
| `get_account_balances` | GL account balances by fiscal year and period (cursor-paginated) |
| `get_budget_vs_actual` | Budget vs actual per account with variance, for a year or a single period |
| `get_journal_entries` | Raw GL transactions; project/free-text fields are optional and require appropriate access |
| `get_projects` | Project financials: revenue, cost, hours, billability |
| `get_timesheets` | Timesheet entries: hours per employee per project, cost and revenue rates |
| `get_consultant_profitability` | Utilization, cost, revenue and margin per consultant and project |
| `get_employees` | Employee list with employment dates |
| `get_customers` | Customer lookup; search covers all customers, not only the first page |
| `get_revenue_summary` | Numbered AR transaction overview by customer and currency; not verified revenue or invoicing |
| `get_invoice_proposals` | Not-yet-invoiced sales orders (invoice proposals) with order-level references |
| `get_invoiced_orders` | Invoiced sales orders with order-level references (PO/contract) |
| `get_expenses` | Expense lines (amount, type, project, approval) |
| `get_expense_reports` | Expense report headers (totals, period, approval, purpose) |
| `get_absences` | Absence hours per employee and type, with the GDPR Art. 9 guard |
| `get_exchange_rates` | Currency exchange rates, filtered server-side by currency pair |
| `get_cash_transactions` | Cash book transactions (only if your organization uses the cash book module) |
| `get_deltas` | Change records for the last 3 days, for incremental sync |

The six tools `get_timesheets`, `get_consultant_profitability`, `get_employees`, `get_expenses`, `get_expense_reports`, and `get_absences` are hidden unless `XLEDGER_ENABLE_PERSONNEL_TOOLS=1`. Personnel deltas are also denied by default.

All tools are annotated with `readOnlyHint: true`. The server never sends GraphQL mutations.

## Quick Start

### Prerequisites

- Node.js 22+ (with Web Crypto and Fetch)
- An Xledger account with GraphQL API access
- An API token (generate at: Xledger > Administration > System Access > GraphQL/API tokens)

### Install and Build

```bash
git clone https://github.com/Eyevinn/xledger-mcp-server.git
cd xledger-mcp-server
npm install
npm run build
```

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `XLEDGER_GRAPHQL_TOKEN` | Yes | — | Your Xledger API token |
| `XLEDGER_API_URL` | No | `https://www.xledger.net/graphql` | API endpoint (use `https://demo.xledger.net/graphql` for testing) |
| `MCP_TRANSPORT` | No | `stdio` | Set to `http` when deploying a remote MCP endpoint for ChatGPT |
| `MCP_AUTH_TOKEN` | HTTP only | — | Legacy bearer secret; disabled by default when OAuth is configured |
| `MCP_ALLOW_LEGACY_BEARER` | No | unset | Set to `1` only for temporary static-token migration alongside OAuth |
| `XLEDGER_ENABLE_PERSONNEL_TOOLS` | No | unset | Set to `1` to explicitly expose the six personnel/employee-expense tools |
| `OAUTH_ISSUER` | ChatGPT web | — | HTTPS issuer URL from the OAuth provider (for example Auth0) |
| `OAUTH_RESOURCE` | ChatGPT web | — | Canonical HTTPS identifier for this MCP server; must equal the OAuth API identifier |
| `OAUTH_AUDIENCE` | No | `OAUTH_RESOURCE` | Expected `aud` claim in the OAuth access token |
| `OAUTH_REQUIRED_SCOPE` | No | `xledger:read` | OAuth scope required to call the MCP endpoint |
| `OAUTH_JWKS_URL` | No | Issuer `/.well-known/jwks.json` | OAuth provider's signing-key endpoint |
| `OAUTH_ALLOWED_SUBJECTS` | OAuth | — | Comma-separated exact user IDs permitted to use this shared Xledger connection; wildcards are rejected |
| `XLEDGER_ALLOW_ART9_DETAIL` | No | unset | Set to `1` only if the data controller has decided to allow per-person health absence detail. See [GDPR and absence data](#gdpr-and-absence-data). |

See `.env.example`.

The server communicates over stdio. It is designed to be launched by an MCP client, not run standalone.

### Remote MCP endpoint for ChatGPT

For ChatGPT on the web, deploy the server with `MCP_TRANSPORT=http` and protect it with OAuth 2.1. It exposes a health check at `/health`, OAuth protected-resource metadata at `/.well-known/oauth-protected-resource`, and a Streamable HTTP MCP endpoint at `/mcp`.

ChatGPT web cannot store a customer-provided static bearer secret. It instead follows the OAuth authorization-code flow with PKCE, so the Xledger token remains on the server and each person signs in through the configured identity provider.

Configure an OAuth API at your identity provider first. With Auth0:

1. Use the public MCP domain as the API Identifier and define the single `xledger:read` permission. Use RS256 access-token signing.
2. Keep user-delegated access on **Per-app authorization** and machine-to-machine access on **No apps allowed**. Enable RBAC and assign `xledger:read` only to approved pilot users.
3. Register the ChatGPT client using a method supported by your Auth0 plan (manual CIMD or a predefined client). Copy the exact metadata URL or redirect URI shown by ChatGPT. Do not enable open registration or broad default API grants just for this single-client pilot.
4. Grant that client only user-delegated `xledger:read` access. For a third-party client, enable a suitable domain-level login connection. Keep public signups disabled for a private pilot.
5. Enable Auth0's Resource Parameter Compatibility Profile so ChatGPT's `resource` parameter selects this API. Verify discovery advertises PKCE S256.
6. Copy the issuer **exactly** from Auth0's discovery document, including its trailing slash. Configure the permitted pilot user IDs below. An Auth0 dashboard administrator is not automatically an application user.

Then set the configuration and secrets on the hosting platform, never in the repository:

```text
MCP_TRANSPORT=http
XLEDGER_GRAPHQL_TOKEN=<the Xledger token>
XLEDGER_API_URL=https://demo.xledger.net/graphql
OAUTH_ISSUER=https://your-tenant.us.auth0.com/
OAUTH_RESOURCE=https://your-public-mcp-domain.example
OAUTH_AUDIENCE=https://your-public-mcp-domain.example
OAUTH_REQUIRED_SCOPE=xledger:read
OAUTH_ALLOWED_SUBJECTS=auth0|replace-with-your-pilot-user-id
```

The server verifies the token signature, exact issuer and audience, expiration, granted `xledger:read` scope and permitted user ID on every MCP request. The Auth0 `permissions` claim is not a substitute for delegated scope. Sessions are bound to the authenticated user and OAuth client. It never handles user passwords or stores OAuth client secrets. This is one shared Xledger connection: all permitted users see the data allowed by its server-side Xledger token, not separate per-user Xledger accounts.

After deployment, add `https://your-domain.example/mcp` as a custom MCP server in ChatGPT and complete the sign-in window. Do not enter `XLEDGER_GRAPHQL_TOKEN` or `MCP_AUTH_TOKEN` in ChatGPT. `MCP_AUTH_TOKEN` is ignored when OAuth is configured unless `MCP_ALLOW_LEGACY_BEARER=1`. This explicit migration fallback bypasses OAuth user restrictions; keep it disabled in normal use. Never enable real company data until the authorized-user and denied-user tests both pass end to end.

## Configuration

### Claude Code

Register the server at **user scope**, so the token lives in your personal Claude Code configuration and not in a repository:

```bash
claude mcp add xledger --scope user \
  -e XLEDGER_GRAPHQL_TOKEN=your-token-here \
  -- node /path/to/xledger-mcp-server/dist/index.js
```

Then run `/mcp` inside Claude Code (or restart it) and check that `xledger` is connected.

**Keep the token out of project-scoped `.mcp.json` files.** A project-scoped `.mcp.json` is meant to be committed and shared with everyone who clones the repository, so a token written there ends up in version control. If a project does need the server in its `.mcp.json`, reference an environment variable instead of the literal value, for example `"XLEDGER_GRAPHQL_TOKEN": "${XLEDGER_GRAPHQL_TOKEN}"`, and set the variable in your shell.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "xledger": {
      "command": "node",
      "args": ["/path/to/xledger-mcp-server/dist/index.js"],
      "env": {
        "XLEDGER_GRAPHQL_TOKEN": "your-token-here"
      }
    }
  }
}
```

### VS Code (GitHub Copilot)

Add to your user-level MCP configuration (not a workspace `.vscode/mcp.json` that is committed):

```json
{
  "servers": {
    "xledger": {
      "command": "node",
      "args": ["/path/to/xledger-mcp-server/dist/index.js"],
      "env": {
        "XLEDGER_GRAPHQL_TOKEN": "your-token-here"
      }
    }
  }
}
```

### Verify that it boots

No real token is needed to list the tools:

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"diag","version":"1.0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
 | XLEDGER_GRAPHQL_TOKEN=dummy node dist/index.js | grep -oE '"name":"get_[a-z_]+"' | sort -u | wc -l
# Expected: 19
```

## GDPR and absence data

Absence is booked as timesheet rows on absence projects or absence time types. An absence type tied to a named person can reveal health information (sick leave, care of a sick child). That is special-category personal data under GDPR Art. 9, and every tool result is sent to the AI model provider your MCP client uses.

The server therefore enforces the following before any data leaves it, instead of relying on an instruction to the assistant.

### `get_absences`

- **Default:** only absence types positively recognised as non-health (vacation, parental leave, time off in lieu, leave of absence) are returned per employee. Health-related types, **and any type the server does not recognise**, are collapsed into one anonymous aggregate (`healthRelatedAbsence`: total hours and number of employees, no names, no absence codes). The guard fails closed.
- `totalAbsenceHours` always includes all absence, so utilization calculations are unaffected.
- Temporary parental benefit/leave (`Tillfällig föräldrapenning`, `Temporary parental leave`, `VAB`, `Vård av barn`) is care of a sick child and is treated as health, even though it mentions parental leave.

### Other tools that return per-person rows

- **`get_timesheets`, `get_expenses`, `get_journal_entries`:** a row is redacted when its project name (or, for timesheets, its time-type name) matches any absence, health-related or non-health absence term. It keeps its hours, amounts, dates and employee, but the project name and code and the time-type name are replaced, and free-text fields (`text`, `comment`) are removed. The response then carries `absenceRowsRedacted` and a `note`. All absence rows are redacted this way, not only health-related ones, so the guard fails closed.
- **Two predicates.** Counting and redaction use different rules on purpose. A row is *counted* as absence (in `get_absences`, `hours.absence` and the `Absence` label) when its project **or** time type matches an explicit absence term, the same rule in every tool. *Redaction* is broader and errs on the safe side: it also matches stems such as `medical`, `temporary` or `tillf`, so a customer project like `Medical imaging` is redacted, labelled `Redacted` instead of `Absence`, and still counted as ordinary work.
- **`get_consultant_profitability`:** absence hours count only into `hours.absence` (and are excluded from the utilization base). Absence projects never appear in the per-consultant `projects` breakdown. Other projects that the redaction rule matches are listed as `Redacted (billable)` / `Redacted (non-billable)`.
- `get_projects`, `get_employees`, `get_expense_reports` and `get_deltas` return no project or time-type names alongside a person (the `timesheets` delta returns employee, date and hours only) and are not filtered.

### Override (all guarded tools)

Per-person detail is returned only when the caller sets `includeHealthDetail: true` **and** the server was started with `XLEDGER_ALLOW_ART9_DETAIL=1`. Either one alone is refused, and the response says so (`healthDetailRefused`). The environment variable is a decision for the data controller, made with a documented lawful basis; the assistant cannot set it.

Absence projects and types are matched on common Swedish and English names. Before matching, every name is normalised (Unicode NFD, diacritics removed, lower case), so `Läkarbesök`, a decomposed (NFD) `Läkarbesök` and the ASCII spelling `Lakarbesok` are treated the same. Covered names include:

- **Counted as absence and never shown per person:** `Sjuk`/`Sick`/`Illness`, `Karens`, `VAB`/`Vård av barn`, `Tillfällig föräldrapenning`/`Temporary parental leave`, `Läkarbesök`/`Läk.`, `Tandläkare`/`Dentist`, `Doctor appointment`, `Medical appointment`, `Medical leave`, `Hospital visit`/`Sjukhusbesök`, `Rehab`, `Närståendepenning`/`Vård av anhörig`, `Graviditetspenning`, `Smittbärarpenning`, `Arbetsskada`/`Occupational injury`, `Childcare`, and unrecognised names such as `Frånvaro`/`Absence`, `Ledighet` or `Leave`.
- **Counted as absence and shown per person (non-health):** `Semester`/`Vacation`/`Holiday`/`Annual leave`, `Föräldraledig`/`Parental leave`, `Tjänstledig`/`Leave of absence`, `Kompledig`/`Komptid`/`Time off in lieu`/`TOIL`.
- **Redacted only, not counted:** names containing broader health stems such as `medical`, `hospital`, `doctor`, `psyk`, `injury`, `anhörig`, `temporary` or `tillf`. A customer project like `Medical imaging` is redacted but stays ordinary work. `Kompetensutveckling` is not matched.

In `get_absences`, a row is shown per person only if neither its project nor its time type names a health term and at least one of them is a recognised non-health type; a health term on either name sends the row to the anonymous aggregate. Names outside these lists are not recognised as absence. See `src/absences.ts` if your Xledger setup uses other names.

### Not covered

The guard works on project and time-type names only. The following are returned as stored in Xledger and are **not** filtered:

- **`get_expenses`** returns the expense type per named employee. An expense type can itself be health-related (for example a medical or healthcare expense type).
- **`get_journal_entries`** returns account names together with employee subledgers. An account name can reveal health information (for example a sick-pay account) for the person on the subledger.
- Free-text fields (`text`, `comment`, expense report `overview`) on rows the guard does not match.

The deploying organisation must assess these in its DPIA, or restrict access to those tools (for example through the MCP client's tool permissions or the API token's owner-scopes).

## Tool notes

- **`get_account_balances` / `get_budget_vs_actual`:** Xledger v2 has no year filter on balances and no `offset`, so the server pages through balances newest-first with cursors and filters client-side. `periodNumber` returns that single period only; omit it for all periods of the year.
- **Paginated tools** read at most 20 pages of 500 rows. Financial list outputs report `sourceComplete`, `complete`, `hasMore` and a warning when a source/page/output limit prevents completeness. Repeated or missing cursors are treated as incomplete. Invoice summaries report `complete` and a warning for incomplete sources.
- **`get_invoice_line_records`** reads one page of at most 50 records, not 20 pages. Use `nextCursor` as `after` with the same source and parent filter. A continuation page is never labelled a complete source, even when it is the final page. Missing upstream pagination information is incomplete. Optional `invoiceDbId` means the source's own parent invoice/order header ID, not an AP transaction ID: vendor details use the confirmed `headerDbId` filter; electronic-invoice details expose no direct parent ID filter and reject this option. No unfiltered fallback is performed. Reference objects are opt-in; missing unit/header objects do not mean their values are zero or verified. Permission errors are propagated without trying another source.
- **`get_revenue_summary`** aggregates numbered AR transactions in exact decimal arithmetic. Numbered payment/correction rows cannot be excluded reliably without confirmed transaction-type mapping, so the result explicitly does not certify invoice totals. There is no combined monetary total across currencies. For accrual-based figures, use GL balances.
- **`get_customers`** reads all customers (cursor-paginated) before applying `search`, so a match is never missed because it was outside the first page.
- **`get_invoice_proposals` / `get_invoiced_orders`** read the `salesOrders` connection (the order-level invoice overview). `invoiceNumber` `0` means not yet invoiced. `invoiceAmount` is net excluding VAT; `taxAmount` is the VAT. Reference fields (`yourReference`, `contract`) are compared at order level.
- **`get_consultant_profitability`** takes `monthlySalary` and `hourlyRate` as inputs, because payroll data is usually outside the API token's scope. `agAvgPct` (employer social security contribution) defaults to the Swedish standard rate of 31.42 %.
- **`get_consultant_profitability` / `get_absences`** fetch timesheets in monthly chunks of up to 500 rows. If a month reaches that limit, the response includes a `warning` and `truncatedMonths` instead of silently undercounting.
- **`get_expenses` / `get_expense_reports`:** if the API token's Expense owner-scope is `MINE`, it only sees the integration user's own expenses. An Xledger administrator can widen the scope.
- **`get_cash_transactions`:** `fromDate`/`toDate` always filter on `createdAt`, not bank date. An empty result explains this; permission/filter failures are propagated, never retried using a different date basis.
- **Empty results:** Xledger returns `edges: null` (not `[]`) when nothing matches. All tools handle this and return an empty list or an explanatory note.

## Xledger API v2 Notes

- **Filter syntax**: Direct field suffixes (e.g., `invoiceDate_gte`) instead of `{ AND: [{ field, op, value }] }`
- **OrderBy**: Array of `{ field, direction }` enums instead of single object
- **Pagination**: Connections expose `edges.cursor` and `pageInfo.hasNextPage` but not `endCursor`/`totalCount`, and reject `offset`. Page with `after: <last edge cursor>`.
- **Removed filters**: Some fields are no longer filterable (`fiscalYear` on account balances, `description` on customers, `billable` on projects, `postedDate` on journal entries). These are handled client-side.
- **SystemValue**: Uses `.name` instead of `.description`

## Development

```bash
npm install
npm run build        # Compile TypeScript
npm test             # Run tests
npm run dev          # Watch mode (recompile on changes)
npm run lint         # Type-check without emitting
```

## Security

- The API token grants read access scoped to your Xledger tenant and to the token user's owner-scopes
- Never commit tokens to version control. Use user-scoped MCP configuration or environment variables
- All tools are read-only (no mutations)
- Use Xledger's token scope controls to limit access to only the data you need
- Absence project and time-type names are filtered for GDPR Art. 9 before they leave the server in `get_absences`, `get_timesheets`, `get_consultant_profitability`, `get_expenses` and `get_journal_entries` (see [GDPR and absence data](#gdpr-and-absence-data))
- Expense types, account names with employee subledgers, and free-text fields on rows the guard does not match are returned as entered in Xledger and are not filtered (see [Not covered](#not-covered))

## License

MIT — see [LICENSE](LICENSE)

## About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinn.se) is a Stockholm-based consultancy specializing in video streaming technology. We contribute to the open source community through our [GitHub organization](https://github.com/Eyevinn) and [Open Source Cloud](https://www.osaas.io) platform.
