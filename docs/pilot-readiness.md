# Financial pilot: implementation and next steps

The October 2026 demo tests established that MCP connectivity works but found data-quality defects. This document records the implemented corrections without publishing company accounting data or credentials.

## Implemented in 1.2.0

- Open AR/AP items include nonzero remaining balances of either sign. Credit balances are no longer lost by a positive-only filter.
- Financial list outputs distinguish returned rows, matched rows already fetched, upstream completeness, and output limits. An incomplete source or limited output carries a warning.
- The legacy-named `get_revenue_summary` no longer labels AR transaction sums as invoiced revenue. It excludes unnumbered rows and groups numbered transaction amounts by currency. Numbered settlement/correction rows may remain, so `invoiceClassificationVerified` is false. Use GL balances for accounting revenue.
- Monetary aggregation uses exact decimal arithmetic. Missing budget entries are null and have no calculated variance. An explicitly recorded zero budget stays zero.
- Calendar dates, inclusive date order, fiscal periods, page sizes and currency-code inputs are validated before data requests.
- GL rows are paginated and filtered by fiscal year before the requested output limit. Default GL requests omit Project and free text, so accounting rows do not unnecessarily depend on Project read permissions. Explicit `includeProject=true` preserves access errors and the existing redaction guard.
- Cash-book errors do not trigger a silent switch from creation date to bank date.
- Personnel and employee-expense tools/deltas are disabled by default. Existing guarded tools are available only with `XLEDGER_ENABLE_PERSONNEL_TOOLS=1` after a separate access decision.
- With OAuth configured, a static bearer token is ignored by default. `MCP_ALLOW_LEGACY_BEARER=1` is an explicit temporary migration opt-in.
- Xledger read requests have a 12-second deadline per attempt and at most one retry for transient HTTP/network failures. Permission errors are not retried, and partial GraphQL errors are not converted to success.
- `get_connection_info` reports the configured API endpoint/environment and tries a current-entity lookup without returning credentials. This does not establish the token's full owner scope.
- `get_invoice_line_capabilities` inspects actual Xledger types for quantity, unit price and invoice relationships. It does not yet read invoice lines or documents, and schema visibility is not proof of record-read permission.

## Verify after deployment

1. Confirm `/health` reports version `1.2.0` and unauthenticated `/mcp` remains rejected.
2. Refresh the existing OAuth plugin's metadata, then start a new conversation.
3. Call `get_connection_info`. Confirm the actual endpoint is the intended demo endpoint and confirm the correct current entity. Separately verify the API token's owner/data scope in Xledger.
4. Repeat open AP/AR tests with positive and negative remaining balances. Check list completeness before presenting totals.
5. Compare a selected month's GL account totals against an independent Xledger report. An internal comparison of two MCP tools is not independent reconciliation.
6. Run the invoice-line capability lookup. Preserve the returned field names/types as the basis for implementing a line reader; do not guess a root connection or filter.
7. Confirm user authorization, denied-user behavior and token renewal end to end before enabling production company data. Local OAuth/HTTP tests do not substitute for these production checks.

## Read access still needed in Xledger

The demo token explicitly rejected `Project` and `SalesOrder`. The code cannot grant these permissions. Request only the read access needed for project reports and sales-order detail; keep booking, approval, payments, changes and invoice sending disabled.

For incoming supplier invoices, separately establish whether the original product lines are available as structured API data. If not, confirm an authenticated, supported way to read the original EHF and/or PDF attachments. Accounting allocation rows and purchase-order lines must not be presented as the original supplier invoice's product lines without a verified relationship.

### Draft request for the Xledger administrator

We have now tested our own read-only MCP integration. Please help us complete the existing demo access:

1. Confirm the entity/company and owner scope to which the existing demo token applies.
2. Provide narrowly scoped **read access** to Project and SalesOrder/related order details, which currently return explicit permission errors. Issue a replacement token only if the existing token cannot support the required permissions.
3. Confirm how original product lines on received supplier invoices can be read, including description, quantity, unit, unit price, price basis, discounts, currency, VAT and line amount, linked to the correct company and invoice.
4. If product lines are only in source documents, confirm read access to original EHF/PDF files and their supported API/document relationship.
5. Confirm that production access, when requested later, can be restricted to the agreed company and read-only financial data.

Any replacement token is to be delivered through an agreed secure channel and configured on Railway, not added to repository files. No posting, approval, payments, data changes or invoice sending is requested.

## Invoice line implementation acceptance criteria

The line reader remains a next-stage task until the real schema, access permissions and document sources are verified. It must return company/invoice identity, line identity and source, description, quantity, unit, unit price, price basis, discount, currency, net line amount and VAT where present. Missing fields must be marked as missing, not invented or replaced with zero.

Validate at least a structured incoming EHF invoice, a PDF-only invoice, a credit note and a discount/price-basis example against the originals. Check line sums, taxes and header totals. Normalize price units explicitly before comparing costs per kilogram. Do not divide a mixed invoice total by a guessed quantity.

## Development validation

`npm test` builds the entry point first, then runs unit, in-memory MCP and real HTTP transport tests using isolated dummy credentials and synthetic fixtures. No live company rows or secret values belong in test fixtures or public pull requests.
