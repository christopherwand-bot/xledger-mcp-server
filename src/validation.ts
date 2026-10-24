/**
 * Input validation and date helpers
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateDate(
  value: string | undefined,
  name: string
): void {
  if (value === undefined) return;
  if (!DATE_RE.test(value)) {
    throw new Error(
      `Invalid date format for ${name}: expected YYYY-MM-DD, got "${value}"`
    );
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid calendar date for ${name}: "${value}"`);
  }
}

export function validateDateRange(fromDate?: string, toDate?: string): void {
  validateDate(fromDate, "fromDate");
  validateDate(toDate, "toDate");
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("fromDate must be on or before toDate");
  }
}

export function today(): string {
  return new Date().toISOString().split("T")[0];
}

function parseUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Split an inclusive YYYY-MM-DD range into calendar-month chunks.
 * Works in UTC so the result does not depend on the host time zone.
 */
export function monthChunks(
  fromDate: string,
  toDate: string
): Array<{ start: string; end: string }> {
  validateDateRange(fromDate, toDate);
  const out: Array<{ start: string; end: string }> = [];
  const end = parseUtc(toDate);
  let cur = parseUtc(fromDate);
  while (cur <= end) {
    const d = new Date(cur);
    const lastOfMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0);
    out.push({ start: isoUtc(cur), end: isoUtc(Math.min(lastOfMonth, end)) });
    cur = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return out;
}

/** Number of calendar months touched by an inclusive YYYY-MM-DD range. */
export function monthSpan(fromDate: string, toDate: string): number {
  validateDateRange(fromDate, toDate);
  const [fy, fm] = fromDate.split("-").map(Number);
  const [ty, tm] = toDate.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}
