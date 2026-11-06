# OnlinePOS read adapter (1.8.0)

OnlinePOS is an additional read source on the existing MCP endpoint. Xledger remains the booked accounting source. The first version exposes source revenue/payment observations and end-of-day journal lines; it does not certify a customer cash total before actual field definitions and report coverage have been validated.

## Existing configuration format

The adapter accepts the existing `ONLINEPOS_COMPANIES` **array**, with its original field names. Values below are synthetic; put actual tokens only in the server environment.

```json
[
  {"restaurantId":"honefoss","firmaid":1001,"token":"REPLACE_WITH_REAL_TOKEN","companyName":"Synthetic North"},
  {"restaurantId":"kongsberg","firmaid":1002,"token":"REPLACE_WITH_REAL_TOKEN","companyName":"Synthetic South"}
]
```

The stable mappings are `honefoss` → `kraft_pizzeria_honefoss` and `kongsberg` → `kraft_pizzeria_kongsberg`. Firma-IDs come from configuration, not Xledger owner IDs. Duplicate restaurant IDs/Firma-IDs, unknown restaurants, invalid tokens and malformed JSON fail closed without echoing input or secrets. A shared token is accepted in both records; actual permission for each configured authentication Firma-ID must still be tested.

| Variable | Meaning |
| --- | --- |
| `ONLINEPOS_API_BASE_URL` | `https://api.onlinepos.dk/api`; other destinations are refused so credentials cannot be redirected to an arbitrary host |
| `ONLINEPOS_COMPANIES` | The array above, with actual configured location IDs/tokens/names |
| `ONLINEPOS_ENABLED` | `false` by default; only `true` enables provider requests |
| `ONLINEPOS_SYNC_INTERVAL_MS` | Nonnegative integer, default `0`; recognized as configuration metadata, but this first version never starts a background timer |

Configuration is loaded lazily: missing/invalid POS settings do not prevent existing Xledger tools from starting. Only the new tools validate these settings. Requests retain immutable per-restaurant credentials and never mutate a global current company.

## Read tools

- `get_onlinepos_connection_info`: inspect selected-company settings without returning a token. `checkReadAccess=true` verifies its configured Firma-ID in `/koncern/koncernInfo` when enabled. Only that location and its departments are returned. A metadata match verifies the configured ID, not an independent legal-entity mapping or access to financial endpoints.
- `get_onlinepos_revenue_journals`: GET `/koncern/getKoncernRevenue/{from}/{to}`. The endpoint can return group data; every returned entry is checked for a source Firma-ID and only matching records are exposed. `revenue`, `count`, `diff` and `btypes` retain their source meanings. The public documentation does not define the internal `btypes` schema sufficiently to certify cash-payment totals.
- `get_onlinepos_end_of_day_journals`: the documented read-only POST `/end_of_day_journal`, with `time_from`/`time_to` request parameters and an optional cash-register ID. Only entries whose source `venue_id` matches the configured Firma-ID are exposed. A mismatch/empty result is not proof of zero. Original journal text/account/amount/debit-credit fields are retained; clerk and debtor/card detail are omitted.

All tools use the existing explicit company selection and OAuth. They cannot post a sale, change products, move money or alter a POS record. The POST exception is the vendor-documented **retrieval** endpoint, never a generic HTTP or write facility.

## Time, precision and coverage

Provide `from` and `to` at second precision with an explicit offset, for example `2026-10-01T00:00:00+02:00` to `2026-10-02T00:00:00+02:00`. Windows must be positive and at most 48 elapsed hours (the revenue endpoint's documented limit). The end-of-day call converts those instants to `Europe/Oslo` local timestamps. Provider inclusion rules, closing times and business-day boundaries still require a live comparison; never blindly add adjacent windows or assume recording date equals sales date.

JSON number lexemes are preserved as strings before monetary parsing, preventing binary float rounding. No currency is guessed. Output uses `first`/`offset`/`nextOffset` and distinguishes upstream completeness from output paging. Unexpected upstream continuation leaves `sourceComplete=false`; undocumented continuation URLs are never followed with credentials. Missing roots, API errors and empty responses cannot become verified zero payments. Repeated source journal identities are refused for review.

The HTTP client uses a fixed destination, redirect refusal, a 12-second request timeout and a 2 MiB response bound. It does not return raw provider error bodies. Input JSON errors never echo token-bearing text. Results omit staff/clerk and debtor/card fields and treat remaining source text as untrusted data, not instructions.

## Acceptance gate

Automated checks cover the user's array shape, multi-company isolation, disabled/no-background behavior, numeric precision, time offsets/DST, output coverage, API failures, identity mismatches, duplicates, read-only request paths and the actual MCP protocol. These are not production evidence of token permissions, response layout, payment semantics or complete report coverage.

After deployment, load real credentials in the existing array format, explicitly enable the adapter, refresh the MCP tool catalogue and probe each selected location. Read a small known interval, inspect actual `btypes` and original journal definitions, then reconcile two known POS reports including refunds/change/tips/float before implementing automatic cash totals. A token accepted for one venue/endpoint does not establish access to the other venue/endpoint. Do not replace or regenerate keys based only on an untested assumption about their group scope.

Primary API reference: [OnlinePOS External API v2](https://speca.io/SimonOnlinePOS/external-api-v2?key=41502b8375f30e56b210877ef797b7e4), linked from [OnlinePOS Norway](https://www.onlinepos.no/kontakt/salg). The published location inventory, revenue journal fields/48-hour limit and end-of-day retrieval contract were checked on 2026-11-06. Actual responses remain a live acceptance dependency.
