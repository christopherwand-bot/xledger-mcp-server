import { describe, expect, it, vi } from "vitest";
import { OnlinePosRegistry, onlinePosLocalTime, onlinePosWindow, parseOnlinePosJson } from "../src/onlinepos.js";

const H = "kraft_pizzeria_honefoss", K = "kraft_pizzeria_kongsberg";
export const posConfig = [
  { restaurantId: "honefoss", firmaid: 1001, token: "synthetic-h-secret", companyName: "Test Restaurant North" },
  { restaurantId: "kongsberg", firmaid: 1002, token: "synthetic-k-secret", companyName: "Test Restaurant South" },
];
export const posRange = { from: "2026-10-01T00:00:00+02:00", to: "2026-10-02T00:00:00+02:00" };
export const posEnv = (extra: Record<string, string> = {}) => ({ ONLINEPOS_ENABLED: "true", ONLINEPOS_API_BASE_URL: "https://api.onlinepos.dk/api",
  ONLINEPOS_COMPANIES: JSON.stringify(posConfig), ONLINEPOS_SYNC_INTERVAL_MS: "0", ...extra });
const metadata = { lokations: posConfig.map(c => ({ firmaid: c.firmaid, name: c.companyName, city: "Test City", country: "Test Country", active: 1,
  departments: [{ departmentID: c.firmaid + 100, departmentName: "Test register", departmentActive: 1, lastJournal: 3, parent_firmaid: c.firmaid }] })) };
const revenue = (firmaid = 1002, booknumber = 10) => ({ entry: { firmaid, departmentid: firmaid + 100, booknumber,
  revenue: "123.4567", count: "100", diff: "23.4567", startdate: 1790805600, enddate: 1790892000,
  btypes: { k: { name: "Kontant", amount: "100.00", cardnumber: "not-for-output" } }, clerk: "not-for-output" } });
const journal = (venue_id = 1002) => ({ venue_id, venue_name: "Test Restaurant", journal_number: 12, cash_register_id: 1102,
  cash_register_name: "Test register", department_code: "TEST", time: "2026-10-02T01:00:00", clerk_id: 999,
  journal_lines: [{ journal_line_text: "Cash counted", journal_line_account_number: "1905", journal_line_amount: 123.45, journal_line_type: "debit" }],
  extended_data: { debtor_sales: [{ debtor_name: "Not for output", card_number: "not-for-output" }] } });
function backend(options: { env?: Record<string, string>; meta?: any; rows?: any[]; journals?: any[]; body?: string; status?: number; next?: string; fail?: boolean } = {}) {
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (options.fail) throw new Error("DO-NOT-ECHO synthetic-k-secret");
    if (url.pathname.endsWith("/koncernInfo")) return new Response(JSON.stringify(options.meta || metadata));
    if (options.status) return new Response("private-body synthetic-k-secret", { status: options.status });
    return new Response(options.body ?? JSON.stringify(url.pathname.endsWith("/end_of_day_journal")
      ? { journal_entries: options.journals ?? [journal()] }
      : { entries: options.rows ?? [revenue()], next_page_url: options.next ?? null }));
  });
  return { fetcher, registry: new OnlinePosRegistry(posEnv(options.env), fetcher) };
}

describe("existing OnlinePOS array configuration", () => {
  it("uses the supplied field names and maps both restaurant IDs to explicit company IDs", async () => {
    const { registry, fetcher } = backend();
    const [h, k] = await Promise.all([registry.info(H), registry.info(K)]);
    expect(h).toMatchObject({ configured: true, restaurantId: "honefoss", firmaid: 1001, backgroundSyncEnabled: false });
    expect(k).toMatchObject({ configured: true, restaurantId: "kongsberg", firmaid: 1002 });
    expect(JSON.stringify([h, k])).not.toMatch(/synthetic-[hk]-secret/); expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps existing Xledger use independent of missing POS configuration", async () => {
    const registry = new OnlinePosRegistry({});
    expect(await registry.info(H)).toMatchObject({ configured: false, enabled: false, location: null });
  });
  it("disabled means no provider calls, including an explicit metadata probe", async () => {
    const { registry, fetcher } = backend({ env: { ONLINEPOS_ENABLED: "false" } });
    expect(await registry.info(H, true)).toMatchObject({ metadataProbe: "not_run_disabled_or_unconfigured", location: null });
    await expect(registry.revenue(H, posRange)).rejects.toThrow("disabled"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("accepts a shared token without mixing the two Firma-IDs", async () => {
    const shared = posConfig.map(c => ({ ...c, token: "same-synthetic-token" }));
    const { registry, fetcher } = backend({ env: { ONLINEPOS_COMPANIES: JSON.stringify(shared) } });
    await Promise.all([registry.info(H, true), registry.info(K, true)]);
    expect(fetcher.mock.calls.map(([, init]) => init?.headers)).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: "same-synthetic-token", firmaid: "1001" }), expect.objectContaining({ token: "same-synthetic-token", firmaid: "1002" }),
    ]));
  });
  it("does not activate a timer when a previously supplied interval is nonzero", async () => {
    const { registry, fetcher } = backend({ env: { ONLINEPOS_SYNC_INTERVAL_MS: "300000" } });
    expect(await registry.info(K)).toMatchObject({ backgroundSyncEnabled: false, configuredSyncIntervalMs: 300000 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ONLINEPOS_COMPANIES: '{"private-token":"synthetic-secret"' },
    { ONLINEPOS_COMPANIES: '{}' },
    { ONLINEPOS_COMPANIES: JSON.stringify([...posConfig, posConfig[0]]) },
    { ONLINEPOS_COMPANIES: JSON.stringify(posConfig.map(c => ({ ...c, firmaid: 1001 }))) },
    { ONLINEPOS_COMPANIES: JSON.stringify([{ ...posConfig[0], restaurantId: "other" }]) },
    { ONLINEPOS_COMPANIES: JSON.stringify([{ ...posConfig[0], token: "SKJULT" }]) },
    { ONLINEPOS_COMPANIES: JSON.stringify([{ ...posConfig[0], token: "secret\nheader:bad" }]) },
    { ONLINEPOS_API_BASE_URL: "https://untrusted.example/api" },
    { ONLINEPOS_API_BASE_URL: "https://api.onlinepos.dk/api?token=synthetic-secret" },
    { ONLINEPOS_ENABLED: "yes" }, { ONLINEPOS_SYNC_INTERVAL_MS: "-1" },
  ])("rejects invalid configuration without echoing secrets %j", async env => {
    const { registry, fetcher } = backend({ env });
    const error = await registry.info(K).catch(e => e);
    expect(error).toBeInstanceOf(Error); expect(error.message).not.toMatch(/synthetic-secret|private-token|header:bad/);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses an unconfigured company without silently selecting a restaurant", async () => {
    const { registry, fetcher } = backend();
    await expect(registry.revenue("kraftgutta", posRange)).rejects.toThrow("not configured"); expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("read-only OnlinePOS financial data", () => {
  it("verifies a location before reading finance and filters group data before returning it", async () => {
    const { registry, fetcher } = backend({ rows: [revenue(1001), revenue(1002)] });
    const result = await registry.revenue(K, posRange);
    expect(result).toMatchObject({ source: "onlinepos", firmaid: 1002, returned: 1, matchedFetched: 1, sourceComplete: true, complete: true,
      paymentAmountVerified: false, customerCashPayments: null, currency: null });
    expect(result.items[0]).toMatchObject({ firmaid: 1002, revenue: "123.4567", btypes: { k: { name: "Kontant", amount: "100.00" } } });
    expect(JSON.stringify(result)).not.toMatch(/not-for-output|synthetic-[hk]-secret/);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.onlinepos.dk/api/koncern/koncernInfo");
    expect(fetcher.mock.calls[1][0]).toContain("/getKoncernRevenue/1790805600/1790892000");
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ method: "GET", redirect: "error", headers: { token: "synthetic-k-secret", firmaid: "1002" } });
  });
  it("keeps simultaneous company reads separate even with overlapping journal numbers", async () => {
    const { registry, fetcher } = backend({ rows: [revenue(1001), revenue(1002)] });
    const [h, k] = await Promise.all([registry.revenue(H, posRange), registry.revenue(K, posRange)]);
    expect(h.items.map(r => r.firmaid)).toEqual([1001]); expect(k.items.map(r => r.firmaid)).toEqual([1002]);
    expect(fetcher.mock.calls.filter(([u]) => String(u).includes("getKoncernRevenue")).map(([, init]) => (init?.headers as any).firmaid).sort()).toEqual(["1001", "1002"]);
  });
  it("does not call a complete empty response zero customer payments", async () => {
    const { registry } = backend({ rows: [] });
    expect(await registry.revenue(K, posRange)).toMatchObject({ dataStatus: "no_matching_rows; not_verified_zero", customerCashPayments: null });
  });
  it("does not certify absent payment observations", async () => {
    const row = revenue(); delete (row.entry as any).btypes;
    const result = await backend({ rows: [row] }).registry.revenue(K, posRange);
    expect(result.items[0]).toMatchObject({ btypes: null, paymentBreakdownPresent: false });
    expect(result.paymentAmountVerified).toBe(false);
  });
  it.each([{}, { lokations: [] }, { lokations: [metadata.lokations[0]] }, { lokations: [metadata.lokations[1], metadata.lokations[1]] }])("blocks unverified location inventory %j", async meta => {
    const { registry, fetcher } = backend({ meta });
    await expect(registry.revenue(K, posRange)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([403, 429, 500])("propagates HTTP %i without leaking provider error bodies or retrying another company", async status => {
    const { registry, fetcher } = backend({ status });
    const error = await registry.revenue(K, posRange).catch(e => e);
    expect(error.code).toBe(`HTTP_${status}`); expect(error.message).not.toMatch(/private-body|synthetic-k-secret/); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(['{"error":"private failure synthetic-k-secret"}', '{"status":"OK"}', '<html>Sign in</html>', '{"entries":', '{"entries":[{"entry":{"revenue":"0"}}]}'])
    ("refuses malformed, missing or unscoped response data", async body => {
      const { registry } = backend({ body });
      const error = await registry.revenue(K, posRange).catch(e => e);
      expect(error).toBeInstanceOf(Error); expect(error.message).not.toMatch(/private failure|synthetic-k-secret/);
    });
  it("rejects a repeated journal identity before any aggregation", async () => {
    await expect(backend({ rows: [revenue(), revenue()] }).registry.revenue(K, posRange)).rejects.toThrow("Repeated");
  });
  it("rejects array-valued owner identifiers instead of coercing them into a company ID", async () => {
    const row = revenue(); (row.entry as any).firmaid = [1002];
    await expect(backend({ rows: [row] }).registry.revenue(K, posRange)).rejects.toThrow("record identifier");
  });
  it("does not certify undocumented pagination metadata as complete coverage", async () => {
    const body = JSON.stringify({ entries: [revenue()], current_page: 1, total: 1000 });
    expect(await backend({ body }).registry.revenue(K, posRange)).toMatchObject({ complete: false, sourceComplete: false });
  });
  it("exposes output continuation and incomplete upstream coverage separately", async () => {
    const { registry } = backend({ rows: [revenue(1002, 10), revenue(1002, 11)], next: "https://untrusted.example/?token=private" });
    const first = await registry.revenue(K, { ...posRange, first: 1 });
    expect(first).toMatchObject({ complete: false, sourceComplete: false, hasMore: true, nextOffset: 1 });
    const last = await registry.revenue(K, { ...posRange, offset: 1, first: 1 });
    expect(last).toMatchObject({ complete: false, sourceComplete: false, hasMore: false, nextOffset: null });
    expect(JSON.stringify(first)).not.toContain("untrusted.example");
  });
  it("reads end-of-day source lines without treating cash counted as customer receipts", async () => {
    const { registry, fetcher } = backend({ journals: [journal(1001), journal()] });
    const result = await registry.journals(K, { ...posRange, cashRegisterId: 1102 });
    expect(result).toMatchObject({ returned: 1, firmaid: 1002, paymentAmountVerified: false, customerCashPayments: null,
      providerLocalWindow: { time_from: "2026-10-01T00:00:00", time_to: "2026-10-02T00:00:00", timeZone: "Europe/Oslo" } });
    expect(result.items[0].journal_lines[0].journal_line_amount).toBe("123.45");
    expect(JSON.stringify(result)).not.toMatch(/clerk_id|extended_data|Not for output/);
    const [input, init] = fetcher.mock.calls[1]; const url = new URL(String(input));
    expect(url.pathname).toBe("/api/end_of_day_journal"); expect(url.searchParams.get("cash_register_id")).toBe("1102");
    expect(init?.method).toBe("POST"); expect(init?.body).toBeUndefined();
  });
  it("refuses a different requested cash register", async () => {
    await expect(backend().registry.journals(K, { ...posRange, cashRegisterId: 999 })).rejects.toThrow("different cash register");
  });
  it("bounds provider responses rather than silently truncating them", async () => {
    const { registry } = backend({ body: "x".repeat(2 * 1024 * 1024 + 1) });
    await expect(registry.revenue(K, posRange)).rejects.toMatchObject({ code: "RESPONSE_LIMIT" });
  });
});

describe("financial number and date precision", () => {
  it("preserves monetary numeric lexemes, large integers and quoted text exactly", () => {
    const parsed = parseOnlinePosJson('{"amount":0.10000000000000001,"id":9007199254740993,"negative":-0.0010,"exp":1.23e4,"text":"A123 \\\" 0.5","flag":true,"nil":null}');
    expect(parsed).toEqual({ amount: "0.10000000000000001", id: "9007199254740993", negative: "-0.0010", exp: "1.23e4", text: 'A123 " 0.5', flag: true, nil: null });
  });
  it.each(['{"n":01}', '{"n":-}', '{"text":"unterminated}', '{"secret":"private"'])
    ("refuses invalid JSON without returning input", input => { expect(() => parseOnlinePosJson(input)).toThrow(/OnlinePOS/); });
  it("handles Oslo's winter/summer offsets explicitly", () => {
    expect(onlinePosLocalTime(Date.parse("2026-01-01T00:00:00+01:00") / 1000)).toBe("2026-01-01T00:00:00");
    expect(onlinePosLocalTime(Date.parse("2026-07-01T00:00:00+02:00") / 1000)).toBe("2026-07-01T00:00:00");
    expect(onlinePosWindow("2026-10-25T00:00:00+02:00", "2026-10-26T00:00:00+01:00").toUnix - onlinePosWindow("2026-10-25T00:00:00+02:00", "2026-10-26T00:00:00+01:00").fromUnix).toBe(25 * 3600);
  });
  it.each([
    { from: "2026-02-30T00:00:00+01:00", to: "2026-03-01T00:00:00+01:00" },
    { from: "2026-10-01T00:00:00", to: posRange.to },
    { from: posRange.to, to: posRange.from },
    { from: posRange.from, to: "2026-10-04T00:00:00+02:00" },
  ])("rejects invalid or excessive ranges before provider calls", async range => {
    const { registry, fetcher } = backend();
    await expect(registry.revenue(K, range)).rejects.toThrow(); expect(fetcher).not.toHaveBeenCalled();
  });
});
