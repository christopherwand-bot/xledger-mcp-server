# Invoice documents: validation and rollout

Version 1.4.0 adds original-document retrieval, PDF/UBL readers, a per-invoice scan ledger and item price history. It is read-only against Xledger. Original files are processed in private temporary directories, removed after the read, and are not sent to an external OCR/AI provider. Checkpoints retain invoice identities, read statuses, extracted lines and document hashes, not signed URLs or full document text.

## Verified source contract

Authenticated demo introspection and record reads on 2026-10-24 verified:

- `APTransaction` (capital AP), `VendorInvoice`, `TransactionHeader` and `Url`.
- CURRENT-owner `apTransactions`/`vendorInvoices` connections, bounded `first`/`after`, date, exact ID and supplier filters.
- `invoiceFile { dbId ownerDbId url fileName }` and `transactionHeader { dbId ownerDbId invoiceFile { ... } }`.
- Real AP records whose direct `invoiceFile` is null but whose transaction header has the original document reference. Observed signed links carry a Unix-seconds `valid_until`; a scan refreshes expiring/aged links through the exact invoice before reading them.

An actual signed demo file URL returned HTTP 404, both without and with same-origin API authentication in a diagnostic check. The implementation uses the signed URL without forwarding credentials. A document reference therefore does not establish download availability. Demo file availability is a remaining live-environment dependency, not a completed end-to-end download test.

A privately held original supplier PDF was independently used to validate the positioned reader. Every item row was extracted, including separate ordered/delivered quantities, three-decimal item prices, thousands-separated net amounts and wrapped descriptions. Extracted line amounts matched the printed line net total. The original and its company data are not in this repository; public tests use synthetic invoices only.

## Acceptance checks

1. Build/test the exact commit, including actual native PDF extraction, EHF reconciliation, price math, source ownership, URL/network boundaries, continuation and checkpoint recovery.
2. Deploy the Dockerfile, which supplies Poppler and local Tesseract English/Norwegian OCR. Confirm `/health` is 1.4.0 and anonymous `/mcp` remains rejected.
3. Reload the tool catalogue. Confirm the six new document/scan/price tools appear and remain annotated read-only.
4. Use `get_connection_info`, then `get_invoice_documents` and `read_invoice_document` on an exact known invoice in the configured environment. Verify the actual original download, identity, page count, line net reconciliation and PDF resource delivery in the client.
5. Run a selected-period scan. Check every per-invoice status, all source enumeration results, failed/missing files and `coverage.allInvoicesRead` before presenting full-period price conclusions.
6. Test at least one structured EHF, credit, scanned PDF and an unsupported layout against actual token-visible originals. OCR/unrecognized layouts must stay in review, even when text is readable.

Use one application replica. HTTP sessions share a worker in the process; the file store is not a distributed queue. Set a writable `XLEDGER_INVOICE_SCAN_DIR` on a mounted volume only if checkpoint survival across deployments is needed. Otherwise deployment loss is disclosed and a fresh scan is required. No new external database or AI subscription is required.

## Pricing contract

UBL uses `quantity × (PriceAmount / BaseQuantity) + line charges − line allowances`, with the Peppol R120 tolerance of 0.02. PriceAmount is already the item net price, so price-level discounts are not deducted twice. Line currency and base-quantity units must match; document line net totals must reconcile. No price is inferred from AP invoice totals. Credits and OCR/unreconciled readings are excluded from ordinary purchase-price history.

Comparison groups preserve supplier, product, currency, normalized unit and pack size. A single explicit pack weight can establish a kg/litre basis; an ambiguous multipack cannot. The result includes both the printed item price/base quantity and the effective net unit price from the line amount, so cent-rounding effects remain visible. Header charges/discounts are not distributed to items. Identical document hashes are not counted twice; accounting records remain visible in coverage.

Primary references: [Xledger GraphQL documentation](https://xledgerukinternal.zendesk.com/hc/en-us/articles/4410822970002-Documentation), [Peppol item price](https://docs.peppol.eu/poacc/billing/3.0/syntax/ubl-invoice/cac-InvoiceLine/cac-Price/), [Peppol R120](https://docs.peppol.eu/poacc/billing/3.0/rules/ubl-peppol/PEPPOL-EN16931-R120/).
