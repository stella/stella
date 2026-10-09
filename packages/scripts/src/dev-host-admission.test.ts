import { describe, expect, test } from "bun:test";

import {
  decideHostAdmission,
  parseDarwinFileUsage,
  parseLinuxFileNr,
} from "./dev-host-admission";

describe("decideHostAdmission", () => {
  test("admits below the threshold and at it", () => {
    expect(decideHostAdmission({ usage: { max: 1000, open: 100 } }).type).toBe(
      "admit",
    );
    expect(decideHostAdmission({ usage: { max: 1000, open: 700 } }).type).toBe(
      "admit",
    );
  });

  test("refuses above the threshold with a readable message", () => {
    const decision = decideHostAdmission({ usage: { max: 1000, open: 701 } });
    expect(decision.type).toBe("refuse");
    if (decision.type === "refuse") {
      expect(decision.message).toContain("701 of 1000");
    }
  });

  test("an unreadable or nonsensical probe admits with a warning", () => {
    for (const usage of [
      null,
      { max: 0, open: 5 },
      { max: Number.NaN, open: 1 },
    ]) {
      expect(decideHostAdmission({ usage }).type).toBe("admit-unverified");
    }
  });
});

describe("file usage parsers", () => {
  test("reads sysctl output", () => {
    expect(parseDarwinFileUsage("184313\n184320\n")).toEqual({
      max: 184_320,
      open: 184_313,
    });
  });

  test("reads file-nr", () => {
    expect(parseLinuxFileNr("1234\t0\t9999\n")).toEqual({
      max: 9999,
      open: 1234,
    });
  });

  test("garbage parses to null", () => {
    expect(parseDarwinFileUsage("")).toBeNull();
    expect(parseDarwinFileUsage("12")).toBeNull();
    expect(parseDarwinFileUsage("a b")).toBeNull();
    expect(parseLinuxFileNr("x")).toBeNull();
  });
});
