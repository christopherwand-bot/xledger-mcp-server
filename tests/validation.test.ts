import { describe, it, expect } from "vitest";
import { validateDate, validateDateRange, today } from "../src/validation.js";

describe("validateDate", () => {
  it("accepts valid YYYY-MM-DD dates", () => {
    expect(() => validateDate("2025-01-15", "test")).not.toThrow();
    expect(() => validateDate("2026-12-31", "test")).not.toThrow();
  });

  it("accepts undefined (optional dates)", () => {
    expect(() => validateDate(undefined, "test")).not.toThrow();
  });

  it("rejects invalid date formats", () => {
    expect(() => validateDate("2025/01/15", "test")).toThrow(
      'Invalid date format for test: expected YYYY-MM-DD, got "2025/01/15"'
    );
    expect(() => validateDate("15-01-2025", "test")).toThrow();
    expect(() => validateDate("not-a-date", "test")).toThrow();
    expect(() => validateDate("2025-1-5", "test")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validateDate("", "test")).toThrow();
  });

  it.each(["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-04-31"])("rejects impossible calendar date %s", date => {
    expect(() => validateDate(date, "test")).toThrow("calendar date");
  });

  it("accepts leap day and the same start/end date", () => {
    expect(() => validateDateRange("2024-02-29", "2024-02-29")).not.toThrow();
  });

  it("rejects an inverted date interval before any API request", () => {
    expect(() => validateDateRange("2026-04-30", "2026-04-01")).toThrow("on or before");
  });
});

describe("today", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = today();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("monthChunks", async () => {
  const { monthChunks, monthSpan } = await import("../src/validation.js");

  it("splits a range into calendar months, inclusive", () => {
    expect(monthChunks("2026-01-15", "2026-03-10")).toEqual([
      { start: "2026-01-15", end: "2026-01-31" },
      { start: "2026-02-01", end: "2026-02-28" },
      { start: "2026-03-01", end: "2026-03-10" },
    ]);
  });

  it("handles a single day and year boundaries", () => {
    expect(monthChunks("2026-05-05", "2026-05-05")).toEqual([{ start: "2026-05-05", end: "2026-05-05" }]);
    expect(monthChunks("2025-12-30", "2026-01-02")).toEqual([
      { start: "2025-12-30", end: "2025-12-31" },
      { start: "2026-01-01", end: "2026-01-02" },
    ]);
  });

  it("rejects an inverted range", () => {
    expect(() => monthChunks("2026-02-01", "2026-01-01")).toThrow("on or before");
  });

  it("counts months touched", () => {
    expect(monthSpan("2026-01-15", "2026-03-10")).toBe(3);
    expect(monthSpan("2025-12-01", "2026-01-31")).toBe(2);
  });
});
