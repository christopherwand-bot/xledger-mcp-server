import { describe, it, expect } from "vitest";
import { amountUnits, money, compareBalances, listResult, summarizeInvoices } from "../src/finance.js";

const inv = (invoiceNumber: string | null, invoiceAmount: string, currency = "NOK") => ({
  invoiceNumber, invoiceAmount, invoiceRemaining: "0.0000",
  currency: { code: currency }, subledger: { description: "Customer A" },
});

describe("invoice summary accounting semantics", () => {
  it("excludes settlement rows and retains numbered credit notes", () => {
    const result = summarizeInvoices([
      inv("INV-1", "125.0000"), inv(null, "-125.0000"),
      inv("CREDIT-1", "-25.0000"), inv("0", "999.0000"),
    ]);
    expect(result.totals).toEqual({ currency: "NOK", numberedTransactionAmount: "100.00", remainingBalance: "0.00", numberedTransactionCount: 2 });
    expect(result.invoiceClassificationVerified).toBe(false);
    expect(result.totals).not.toHaveProperty("invoiced");
    expect(result.excludedTransactionCount).toBe(2);
    expect(result.transactionCount).toBe(4);
    expect(result.basis).toMatch(/not booked revenue/);
  });

  it("never adds different currencies into one monetary total", () => {
    const result = summarizeInvoices([inv("N-1", "100.0000"), inv("E-1", "10.0000", "EUR")]);
    expect(result.totals).toBeNull();
    expect(result.byCurrency).toHaveLength(2);
    expect(result.byCustomer).toHaveLength(2);
  });

  it("never certifies a numbered payment as a sales invoice", () => {
    const result = summarizeInvoices([inv("INV-1", "100"), inv("INV-1", "-100")]);
    expect(result.invoiceClassificationVerified).toBe(false);
    expect(result.basis).toContain("numbered settlement/correction rows cannot be ruled out");
  });

  it("does not guess missing monetary values or currency", () => {
    expect(() => summarizeInvoices([{ ...inv("I", "10"), currency: null }])).toThrow("currency");
    expect(() => summarizeInvoices([{ ...inv("I", "10"), invoiceAmount: null }])).toThrow("amount");
  });

  it("marks incomplete source totals explicitly", () => {
    expect(summarizeInvoices([inv("1", "10")], true)).toMatchObject({ complete: false, warning: expect.stringContaining("incomplete") });
  });
});

describe("exact decimal money", () => {
  it("adds decimal amounts before rounding and keeps credit signs", () => {
    expect(money(amountUnits("0.1000") + amountUnits("0.2000"))).toBe("0.30");
    expect(money(amountUnits("-1.0050"))).toBe("-1.01");
    expect(money(amountUnits("0.0040"))).toBe("0.00");
    expect(money(amountUnits("99999999999999999.9999"))).toBe("100000000000000000.00");
  });
});

describe("budget availability", () => {
  const balance = (amount: string) => ({ account: { code: "4000", description: "Materials" }, amount });
  it("distinguishes a missing budget from an explicitly zero budget", () => {
    expect(compareBalances([], [balance("12")])[0]).toMatchObject({ budget: null, variance: null, budgetAvailable: false, actual: "12.00" });
    expect(compareBalances([balance("0")], [balance("12")])[0]).toMatchObject({ budget: "0.00", variance: "12.00", budgetAvailable: true });
  });
});

describe("selection completeness", () => {
  it("warns when the requested output limit hides matched rows", () => {
    expect(listResult([{ id: 1 }, { id: 2 }], 1, "balances")).toMatchObject({ returned: 1, matchedFetched: 2, complete: false, hasMore: true });
  });
  it("warns when upstream pagination ended early even for a short result", () => {
    expect(listResult([], 5, "balances", true)).toMatchObject({ sourceComplete: false, complete: false, hasMore: true });
  });
});
