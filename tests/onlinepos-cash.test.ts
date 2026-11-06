import { describe, expect, it } from "vitest";
import { analyseOnlinePosCash, type OnlinePosCashSource } from "../src/onlinepos-cash.js";

const from = Date.parse("2026-10-01T18:00:00+02:00") / 1000;
const to = Date.parse("2026-10-01T23:00:00+02:00") / 1000;
const closed = "2026-10-01T21:00:00+02:00";
const source = (items: any[]): OnlinePosCashSource => ({ firmaid: 1002,
  window: { from: "2026-10-01T18:00:00+02:00", to: "2026-10-01T23:00:00+02:00", fromUnix: from, toUnix: to },
  items, complete: true, sourceComplete: true });
function report(cash: unknown = "3.25", number = 7, closing = "53.25") {
  const revenue = { firmaid: 1002, departmentid: 1102, booknumber: number, revenue: "3.25", diff: "0",
    enddate: String(Date.parse(closed) / 1000), btypes: { Kontant: cash, Betalingskort_Ext: "2" } };
  const line = (text: string, account: string, amount: string, type: string) => ({ journal_line_text: `${number} - ${text}`,
    journal_line_account_number: account, journal_line_amount: amount, journal_line_type: type });
  const journal = { venue_id: 1002, cash_register_id: 1102, journal_number: number, time: closed,
    journal_lines: [line("Revenue", "3000", "3.25", "credit"), line("Startoptælling", "1905", "50", "credit"),
      line("Slutoptælling", "1905", closing, "debit"), line("Tips", "2992", "2", "credit"), line("Visa", "1524", "2", "debit")] };
  return { revenue, journal };
}
function analyse(r = report()) { return analyseOnlinePosCash(source([r.revenue]), source([r.journal])); }

describe("reported cash versus original journal evidence", () => {
  it("joins exact register/journal identities and keeps tips and opening cash out of reported payments", () => {
    const result = analyse();
    expect(result).toMatchObject({ reportedCashFieldSubtotal: "3.25", customerCashPayments: null, verifiedPeriodCashTotal: null,
      paymentAmountVerified: false, currency: null, responseComplete: true, independentReportInventoryVerified: false,
      coverage: { matchedJournals: 1, cashFieldsObserved: 1, cashFieldsUnknown: 0, allReturnedJournalsMatched: true } });
    expect(result.items[0]).toMatchObject({ journalNumber: 7, registerId: 1102, reportedCash: "3.25", closingTimestampMatched: true,
      cashBalanceChange: "3.25", journalBalanceDifference: "0", observations: { tips: [{ amount: "2" }] },
      openingCashCount: { amount: "50", account: "1905" }, closingCashCount: { amount: "53.25" } });
  });
  it("does not substitute a change in counted cash for an absent payment field", () => {
    const r = report(); delete (r.revenue.btypes as any).Kontant;
    expect(analyse(r)).toMatchObject({ reportedCashFieldSubtotal: null, customerCashPayments: null,
      coverage: { cashFieldsObserved: 0, cashFieldsUnknown: 1 }, items: [{ cashBalanceChange: "3.25", reportedCash: null }] });
  });
  it("distinguishes an explicit cash zero from missing data", () => {
    const result = analyse(report("0"));
    expect(result).toMatchObject({ reportedCashFieldSubtotal: "0", coverage: { cashFieldsObserved: 1, cashFieldsUnknown: 0 } });
    expect(result.customerCashPayments).toBeNull();
  });
  it("never turns an empty result into verified zero", () => {
    expect(analyseOnlinePosCash(source([]), source([]))).toMatchObject({ reportedCashFieldSubtotal: null, responseComplete: true,
      coverage: { allReportedCashFieldsPresent: false, allReturnedJournalsMatched: false }, customerCashPayments: null,
      warnings: expect.arrayContaining(["NO_REPORTS_RETURNED_NOT_VERIFIED_ZERO"]) });
  });
  it("adds decimal observations exactly and exposes incomplete cash-field coverage", () => {
    const a = report("0.1", 7), b = report("0.2", 8), c = report(undefined, 9);
    delete (c.revenue.btypes as any).Kontant;
    const result = analyseOnlinePosCash(source([a.revenue, b.revenue, c.revenue]), source([a.journal, b.journal, c.journal]));
    expect(result).toMatchObject({ reportedCashFieldSubtotal: "0.3", positiveReportedCashFieldSubtotal: "0.3",
      coverage: { cashFieldsObserved: 2, cashFieldsUnknown: 1, allReportedCashFieldsPresent: false }, verifiedPeriodCashTotal: null });
  });
  it("separates positive and negative source observations without naming them gross receipts/refunds", () => {
    const a = report("10", 7), b = report("-3.25", 8);
    const result = analyseOnlinePosCash(source([a.revenue, b.revenue]), source([a.journal, b.journal]));
    expect(result).toMatchObject({ reportedCashFieldSubtotal: "6.75", positiveReportedCashFieldSubtotal: "10",
      negativeReportedCashFieldSubtotal: "-3.25", customerCashPayments: null,
      warnings: expect.arrayContaining(["NEGATIVE_REPORTED_CASH_REQUIRES_REVIEW"]) });
  });
  it.each([null, {}, [], "NaN", "Infinity", "1e3", "1.0000000000000000001", "1".repeat(41)])
    ("leaves unsupported monetary representations unknown", cash => {
      expect(analyse(report(cash))).toMatchObject({ reportedCashFieldSubtotal: null, coverage: { cashFieldsUnknown: 1 } });
    });
  it("supports large exact decimals without binary rounding or low-precision decimal addition", () => {
    const a = report("1234567890123456789012345678901234567890.000000000000000001", 7), b = report("0.000000000000000002", 8);
    expect(analyseOnlinePosCash(source([a.revenue, b.revenue]), source([a.journal, b.journal])).reportedCashFieldSubtotal)
      .toBe("1234567890123456789012345678901234567890.000000000000000003");
  });
  it("does not reinterpret a nested k/name payment schema or ambiguous case variants", () => {
    const r = report(); (r.revenue as any).btypes = { k: { name: "Kontant", amount: "3.25" } };
    expect(analyse(r).reportedCashFieldSubtotal).toBeNull();
    (r.revenue as any).btypes = { Kontant: "3.25", kontant: "4" };
    expect(analyse(r).items[0].cashFieldState).toBe("ambiguous_cash_fields");
  });
  it("records missing journals on either side instead of silently dropping unmatched cash evidence", () => {
    const a = report("3.25", 7), b = report("2", 8);
    const result = analyseOnlinePosCash(source([a.revenue]), source([b.journal]));
    expect(result.items).toHaveLength(2); expect(result.coverage.matchedJournals).toBe(0);
    expect(result.warnings).toEqual(expect.arrayContaining(["REVENUE_JOURNAL_MISSING", "END_OF_DAY_JOURNAL_MISSING"]));
  });
  it("keeps a source observation when the journal disagrees, with explicit review warnings", () => {
    const result = analyse(report("3.25", 7, "55"));
    expect(result.items[0]).toMatchObject({ reportedCash: "3.25", cashBalanceChange: "5", journalBalanceDifference: "1.75" });
    expect(result.warnings).toEqual(expect.arrayContaining(["JOURNAL_DOES_NOT_BALANCE", "REPORTED_CASH_DIFFERS_FROM_CASH_BALANCE_CHANGE"]));
  });
  it("never subtracts outlays or adds tips to invent customer cash receipts", () => {
    const r = report(); r.journal.journal_lines.push({ journal_line_text: "7 - Utlegg", journal_line_account_number: "2910",
      journal_line_amount: "5", journal_line_type: "debit" });
    const result = analyse(r); expect(result.reportedCashFieldSubtotal).toBe("3.25");
    expect(result.items[0].observations.outlay[0].amount).toBe("5"); expect(result.customerCashPayments).toBeNull();
  });
  it("rejects scope mismatches and duplicate identities before any aggregation", () => {
    const r = report();
    expect(() => analyseOnlinePosCash(source([r.revenue]), { ...source([r.journal]), firmaid: 1001 })).toThrow("scope");
    expect(() => analyseOnlinePosCash(source([{ ...r.revenue, firmaid: 1001 }]), source([r.journal]))).toThrow("identity");
    expect(() => analyseOnlinePosCash(source([r.revenue, r.revenue]), source([r.journal]))).toThrow("Repeated");
    expect(() => analyseOnlinePosCash(source([r.revenue]), source([r.journal, r.journal]))).toThrow("Repeated");
    expect(() => analyseOnlinePosCash(source([r.revenue]), { ...source([r.journal]), window: { ...source([]).window, toUnix: to + 1 } })).toThrow("window");
  });
  it("does not match equal journal numbers across different registers", () => {
    const r = report(); r.journal.cash_register_id = 999;
    expect(analyse(r)).toMatchObject({ coverage: { matchedJournals: 0 }, items: [{ matchedByRegisterAndJournal: false }, { matchedByRegisterAndJournal: false }] });
  });
  it.each(["2026-10-01T21:00:00", "2026-10-01T21:00:01+02:00", "not a date"])
    ("requires matching unambiguous closing timestamps", time => {
      const r = report(); r.journal.time = time;
      expect(analyse(r)).toMatchObject({ coverage: { allReturnedJournalsMatched: false }, warnings: expect.arrayContaining(["CLOSING_TIMESTAMPS_UNVERIFIED_OR_DIFFERENT"]) });
    });
  it("flags boundary and out-of-window reports before callers combine windows", () => {
    const r = report(); r.revenue.enddate = String(from); r.journal.time = source([]).window.from;
    expect(analyse(r).warnings).toContain("JOURNAL_ON_WINDOW_BOUNDARY_DEDUPLICATE_BEFORE_COMBINING");
    r.revenue.enddate = String(to + 1); r.journal.time = "2026-10-01T23:00:01+02:00";
    expect(analyse(r).warnings).toContain("JOURNAL_CLOSE_OUTSIDE_REQUESTED_WINDOW");
  });
  it("does not infer comparable cash counts from duplicate counts, unknown movements or unsupported types", () => {
    const r = report(); r.journal.journal_lines.push({ ...r.journal.journal_lines[1] });
    expect(analyse(r).items[0].cashBalanceChange).toBeNull();
    r.journal.journal_lines[0].journal_line_type = "unknown";
    expect(analyse(r).items[0].journalBalanceDifference).toBeNull();
    r.journal.journal_lines.push({ journal_line_text: "7 - Cash withdrawal", journal_line_account_number: "1905", journal_line_amount: "4", journal_line_type: "credit" });
    expect(analyse(r).warnings).toContain("OTHER_CASH_ACCOUNT_MOVEMENTS_PRESENT");
  });
  it("reports both upstream and output pagination incompleteness without certifying a period total", () => {
    const r = report();
    expect(analyseOnlinePosCash({ ...source([r.revenue]), complete: false }, { ...source([r.journal]), sourceComplete: false }))
      .toMatchObject({ responseComplete: false, sourceComplete: false, verifiedPeriodCashTotal: null,
        warnings: expect.arrayContaining(["SOURCE_RESPONSE_OR_OUTPUT_COVERAGE_INCOMPLETE"]) });
  });
});
