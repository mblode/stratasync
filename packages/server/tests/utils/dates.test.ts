import {
  dateOnlyStringToEpoch,
  epochToDateOnlyString,
  toDateOnlyDateOrNull,
  toDateOnlyEpoch,
  toInstantDateOrNull,
  toInstantEpoch,
} from "../../src/utils/dates.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// toDateOnlyEpoch
// ---------------------------------------------------------------------------

describe(toDateOnlyEpoch, () => {
  it("returns null for null", () => {
    expect(toDateOnlyEpoch(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toDateOnlyEpoch()).toBeNull();
  });

  // -- Date inputs --

  it("returns epoch for a midnight-UTC Date", () => {
    const date = new Date("2024-06-15T00:00:00.000Z");
    const expected = Date.UTC(2024, 5, 15);
    expect(toDateOnlyEpoch(date)).toBe(expected);
  });

  it("returns null for a Date with a non-zero time component", () => {
    const date = new Date("2024-06-15T12:30:00.000Z");
    expect(toDateOnlyEpoch(date)).toBeNull();
  });

  it("returns null for an invalid Date (NaN)", () => {
    expect(toDateOnlyEpoch(new Date("not-a-date"))).toBeNull();
  });

  // -- Number inputs --

  it("returns the value for a day-aligned epoch", () => {
    // 2025-01-01
    const epoch = Date.UTC(2025, 0, 1);
    expect(toDateOnlyEpoch(epoch)).toBe(epoch);
  });

  it("returns null for a non-day-aligned number", () => {
    expect(toDateOnlyEpoch(DAY_MS + 1)).toBeNull();
  });

  it("returns 0 for epoch 0 (1970-01-01)", () => {
    expect(toDateOnlyEpoch(0)).toBe(0);
  });

  it("returns null for NaN number", () => {
    expect(toDateOnlyEpoch(Number.NaN)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(toDateOnlyEpoch(Number.POSITIVE_INFINITY)).toBeNull();
  });

  // -- String inputs --

  it("parses a valid YYYY-MM-DD string", () => {
    const expected = Date.UTC(2024, 2, 10);
    expect(toDateOnlyEpoch("2024-03-10")).toBe(expected);
  });

  it("returns null for an ISO instant string", () => {
    expect(toDateOnlyEpoch("2024-03-10T12:00:00Z")).toBeNull();
  });

  it("returns null for an invalid date string", () => {
    expect(toDateOnlyEpoch("not-a-date")).toBeNull();
  });

  it("returns null for a date-only string with invalid day (Feb 30)", () => {
    expect(toDateOnlyEpoch("2024-02-30")).toBeNull();
  });

  // -- Other types --

  it("returns null for a boolean", () => {
    expect(toDateOnlyEpoch(true)).toBeNull();
  });

  it("returns null for an object", () => {
    expect(toDateOnlyEpoch({})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toInstantEpoch
// ---------------------------------------------------------------------------

describe(toInstantEpoch, () => {
  it("returns null for null", () => {
    expect(toInstantEpoch(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(toInstantEpoch()).toBeNull();
  });

  // -- Date inputs --

  it("returns epoch ms for a valid Date", () => {
    const date = new Date("2024-06-15T14:30:00.000Z");
    expect(toInstantEpoch(date)).toBe(date.getTime());
  });

  it("returns null for an invalid Date (NaN)", () => {
    expect(toInstantEpoch(new Date("not-a-date"))).toBeNull();
  });

  // -- Number inputs --

  it("returns the number as-is for a finite value", () => {
    expect(toInstantEpoch(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("returns null for NaN", () => {
    expect(toInstantEpoch(Number.NaN)).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(toInstantEpoch(Number.POSITIVE_INFINITY)).toBeNull();
  });

  // -- String inputs --

  it("parses a valid ISO instant string (UTC)", () => {
    const expected = Date.parse("2024-06-15T14:30:00Z");
    expect(toInstantEpoch("2024-06-15T14:30:00Z")).toBe(expected);
  });

  it("parses a valid ISO instant string with offset", () => {
    const expected = Date.parse("2024-06-15T14:30:00+05:30");
    expect(toInstantEpoch("2024-06-15T14:30:00+05:30")).toBe(expected);
  });

  it("parses a valid ISO instant string with fractional seconds", () => {
    const expected = Date.parse("2024-06-15T14:30:00.123Z");
    expect(toInstantEpoch("2024-06-15T14:30:00.123Z")).toBe(expected);
  });

  it("returns null for a date-only string", () => {
    expect(toInstantEpoch("2024-06-15")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(toInstantEpoch("")).toBeNull();
  });

  it("returns null for a garbage string", () => {
    expect(toInstantEpoch("hello")).toBeNull();
  });

  // -- Other types --

  it("returns null for a boolean", () => {
    expect(toInstantEpoch(true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// toDateOnlyDateOrNull
// ---------------------------------------------------------------------------

describe(toDateOnlyDateOrNull, () => {
  it("returns null for null", () => {
    expect(toDateOnlyDateOrNull(null)).toBeNull();
  });

  it("returns a Date for a valid day-aligned epoch", () => {
    const epoch = Date.UTC(2024, 5, 15);
    const result = toDateOnlyDateOrNull(epoch);
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(epoch);
  });

  it("returns null for a non-day-aligned epoch", () => {
    expect(toDateOnlyDateOrNull(DAY_MS + 500)).toBeNull();
  });

  it("returns a Date for a valid YYYY-MM-DD string", () => {
    const result = toDateOnlyDateOrNull("2024-01-01");
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(Date.UTC(2024, 0, 1));
  });
});

// ---------------------------------------------------------------------------
// toInstantDateOrNull
// ---------------------------------------------------------------------------

describe(toInstantDateOrNull, () => {
  it("returns null for null", () => {
    expect(toInstantDateOrNull(null)).toBeNull();
  });

  it("returns a Date for a valid epoch number", () => {
    const epoch = 1_700_000_000_000;
    const result = toInstantDateOrNull(epoch);
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(epoch);
  });

  it("returns a Date for a valid ISO instant string", () => {
    const result = toInstantDateOrNull("2024-06-15T14:30:00Z");
    expect(result).toBeInstanceOf(Date);
    expect(result?.getTime()).toBe(Date.parse("2024-06-15T14:30:00Z"));
  });

  it("returns null for NaN", () => {
    expect(toInstantDateOrNull(Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// dateOnlyStringToEpoch
// ---------------------------------------------------------------------------

describe(dateOnlyStringToEpoch, () => {
  it("returns null for null input", () => {
    expect(dateOnlyStringToEpoch(null)).toBeNull();
  });

  it("parses a valid YYYY-MM-DD string", () => {
    expect(dateOnlyStringToEpoch("2024-03-10")).toBe(Date.UTC(2024, 2, 10));
  });

  it("returns null for a non-date string", () => {
    expect(dateOnlyStringToEpoch("hello")).toBeNull();
  });

  it("returns null for an instant string", () => {
    expect(dateOnlyStringToEpoch("2024-03-10T00:00:00Z")).toBeNull();
  });

  it("returns null for an impossible date (month 13)", () => {
    expect(dateOnlyStringToEpoch("2024-13-01")).toBeNull();
  });

  it("handles leading/trailing whitespace in the string", () => {
    expect(dateOnlyStringToEpoch("  2024-03-10  ")).toBe(Date.UTC(2024, 2, 10));
  });

  it("returns epoch 0 for 1970-01-01", () => {
    expect(dateOnlyStringToEpoch("1970-01-01")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// epochToDateOnlyString
// ---------------------------------------------------------------------------

describe(epochToDateOnlyString, () => {
  it("returns null for null input", () => {
    expect(epochToDateOnlyString(null)).toBeNull();
  });

  it("converts a day-aligned epoch to YYYY-MM-DD", () => {
    expect(epochToDateOnlyString(Date.UTC(2024, 2, 10))).toBe("2024-03-10");
  });

  it("returns null for a non-day-aligned epoch", () => {
    expect(epochToDateOnlyString(DAY_MS + 1)).toBeNull();
  });

  it("converts epoch 0 to 1970-01-01", () => {
    expect(epochToDateOnlyString(0)).toBe("1970-01-01");
  });

  it("pads single-digit month and day", () => {
    expect(epochToDateOnlyString(Date.UTC(2024, 0, 5))).toBe("2024-01-05");
  });
});
