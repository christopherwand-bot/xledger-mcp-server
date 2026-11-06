# Sales-settlement originals (1.7.0)

The invoice readers cover supplier sources. These additional read-only tools locate and read originals attached to posted sales/cash-settlement candidates. They do not derive customer cash payments from debit totals or from the net movement on a cash-balance account.

## Inputs and scope

1. Select the company explicitly. Use `get_posted_transactions` to identify a posted voucher's `headerDbId` and verified transaction `period.dbId`.
2. Call `get_sales_settlement_capabilities` to discover supported `TransactionHeader.invoiceFile` and `attachments` paths. Introspection does not establish record permissions or original availability.
3. Call `get_sales_settlement_documents` with company, fiscal year, period number, optional verified period ID and exact header ID. Only a complete posted `AR` voucher containing sales accounts (`3xxx`) and cash accounts (`190x`) is accepted. This is a candidate classification, not proof that its attachment is a POS daily report. Supplier, payroll and bank-only vouchers are refused.
4. Call `read_sales_settlement_document` with those inputs and one returned `documentId`. Re-querying the source refreshes signed links. An arbitrary caller URL or unrelated file ID is never accepted.

The transaction's own accounting period determines selection. A voucher posting date can differ from the printed report date, so the original's business date/register must be checked separately before aggregating any period.

## Document retrieval and coverage

The reader first verifies posted rows, company, header and period. Document metadata is read through an exact CURRENT-owner `transactions.header` relationship. Primary files and schema-supported attachment pages are enumerated separately. File owner IDs must match the company. Attachments with explicit owner/header IDs are checked too. Duplicate file IDs are returned once. Malformed pages, permission errors and foreign references cannot become verified empty results. Unsupported attachment shapes and interrupted pagination leave `enumerationComplete=false`.

Download and PDF extraction reuse the existing HTTPS-origin restrictions, public-address/DNS checks, bounded downloads, temporary private files, Poppler and local Tesseract. API/OAuth credentials are never forwarded to document links. Signed URLs are omitted from tool output. No new provider or external OCR subscription is introduced. Company-qualified file resources preserve tenant separation.

The text reader accepts daily-report PDFs without requiring invoice numbers or supplier line tables. It reports SHA-256, pages/readable pages, OCR use and whether the original text was fully processed. `textOffset` and `maxTextCharacters` control output paging. `includeFile` embeds the actual linked PDF up to 8 MiB. Non-PDF responses (including sign-in pages), failed downloads and unreadable files have explicit failure statuses.

`paymentEvidence` gives keyword matches with page, line and adjacent text. These are observations, not a typed payment breakdown. OCR and incomplete extraction stay in review. All document text is untrusted source data, never instructions.

## Cash-payment acceptance gate

`paymentAmountVerified=false` and `customerCashPayments=null` are deliberate in this first stage. Neither a readable document, a cash-labelled number nor complete attachment enumeration verifies a customer cash-payment total.

Before adding automatic totals, validate an actual report layout and field definitions: business date/register/report ID, customer cash payments after change, refunds, tips, opening/closing float, cash removals and bank deposits. Reconcile at least two known daily reports against the original POS figures. A date-range reader must enumerate all relevant reports (including days without a cash GL row), exclude duplicate originals/corrections correctly, preserve exact decimal amounts and show missing/failed dates. The present tools establish per-voucher document access, not complete date-range POS coverage.

If originals are absent or do not contain payment-method detail, this endpoint alone cannot reconstruct the missing information. A separate read source from the actual POS system or a suitable export is then needed. A schema field or synthetic test is not production validation of that dependency.

## Verification

Automated checks cover attachment-only originals, duplicate links, multiple pages and cursor quoting, missing/incomplete sources, permission failures, company/header/period mismatches, unrelated/payroll vouchers, actual PDF extraction without invoice rules, OCR review, explicit failure states and the MCP file URI. Production validation requires inspecting actual token-visible originals after deployment and tool-catalogue refresh. Real company documents and financial rows must not be committed as public fixtures.
