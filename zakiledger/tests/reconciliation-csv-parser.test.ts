import { describe, expect, it } from "vitest";
import { parseCsvStatement, parseFlexibleDate } from "../lib/bank-parsers";

describe("parseFlexibleDate", () => {
  it("parses ISO dates", () => {
    expect(parseFlexibleDate("2026-07-15")).toBe("2026-07-15");
  });

  it("parses unambiguous DD/MM/YYYY (day > 12)", () => {
    expect(parseFlexibleDate("15/07/2026")).toBe("2026-07-15");
  });

  it("parses unambiguous MM/DD/YYYY (month position > 12 is impossible, so it's a day)", () => {
    // "07/15/2026" — 15 can't be a month, so the second slot must be the day.
    expect(parseFlexibleDate("07/15/2026")).toBe("2026-07-15");
  });

  it("defaults ambiguous dates to day-first", () => {
    // Both 03 and 04 are valid as day or month — day-first default applies.
    expect(parseFlexibleDate("03/04/2026")).toBe("2026-04-03");
  });

  it("returns null for garbage input", () => {
    expect(parseFlexibleDate("not a date")).toBeNull();
    expect(parseFlexibleDate("31/02/2026")).toBeNull(); // Feb 31 doesn't exist
  });
});

describe("parseCsvStatement", () => {
  it("parses a comma-delimited statement with Debit/Credit columns", () => {
    const csv = [
      "Date,Description,Debit,Credit",
      "15/07/2026,Coffee Shop,4.50,",
      "16/07/2026,Client Payment,,1200.00",
    ].join("\n");

    const result = parseCsvStatement(csv);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({
      transactionDate: { value: "2026-07-15", confidence: 1, reason: "CSV parse" },
      merchant: { value: "Coffee Shop", confidence: 1, reason: "CSV parse" },
      amount: { value: 4.5, confidence: 1, reason: "CSV parse" }, // debit -> positive
    });
    expect(result.transactions[1]).toMatchObject({
      transactionDate: { value: "2026-07-16", confidence: 1, reason: "CSV parse" },
      merchant: { value: "Client Payment", confidence: 1, reason: "CSV parse" },
      amount: { value: -1200, confidence: 1, reason: "CSV parse" }, // credit -> negative
    });
    expect(result.periodStart).toBe("2026-07-15");
    expect(result.periodEnd).toBe("2026-07-16");
  });

  it("auto-detects a semicolon delimiter (common in European bank exports)", () => {
    const csv = ["Date;Description;Amount", "15/07/2026;Supermarket;-32.10"].join("\n");

    const result = parseCsvStatement(csv);

    expect(result.transactions).toHaveLength(1);
    // Source amount is negative (bank convention: negative = spend); we flip
    // to our positive-for-debit convention.
    expect(result.transactions[0].amount).toMatchObject({ value: 32.1, confidence: 1, reason: "CSV parse" });
  });

  it("flips a single signed Amount column to positive-for-debit", () => {
    const csv = ["Date,Description,Amount", "01/01/2026,Salary,2500.00", "02/01/2026,Rent,-950.00"].join("\n");

    const result = parseCsvStatement(csv);

    expect(result.transactions[0].amount).toMatchObject({ value: -2500, confidence: 1, reason: "CSV parse" }); // source positive (deposit) -> negative (credit)
    expect(result.transactions[1].amount).toMatchObject({ value: 950, confidence: 1, reason: "CSV parse" }); // source negative (spend) -> positive (debit)
  });

  it("skips rows with an unparseable date (e.g. a trailing balance line)", () => {
    const csv = [
      "Date,Description,Amount",
      "01/01/2026,Opening balance carried,0.00",
      "Balance brought forward,,1000.00",
    ].join("\n");

    const result = parseCsvStatement(csv);
    expect(result.transactions).toHaveLength(1);
  });

  it("uses the currency column when present, else the provided default", () => {
    const withCurrency = parseCsvStatement(
      ["Date,Description,Amount,Currency", "01/01/2026,Test,10.00,USD"].join("\n"),
    );
    expect(withCurrency.transactions[0].currency).toBe("USD");
    expect(withCurrency.currency).toBe("USD");

    const withoutCurrency = parseCsvStatement(
      ["Date,Description,Amount", "01/01/2026,Test,10.00"].join("\n"),
      "GBP",
    );
    expect(withoutCurrency.transactions[0].currency).toBe("GBP");
    expect(withoutCurrency.currency).toBe("GBP");
  });

  it("throws a clear error when no date column can be found", () => {
    const csv = ["Foo,Bar", "1,2"].join("\n");
    expect(() => parseCsvStatement(csv)).toThrow(/date column/i);
  });

  it("throws a clear error when no amount column can be found", () => {
    const csv = ["Date,Description", "01/01/2026,Test"].join("\n");
    expect(() => parseCsvStatement(csv)).toThrow(/amount column/i);
  });
});
