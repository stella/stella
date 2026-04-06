import { describe, expect, test } from "bun:test";

import { InfoSoudParseError } from "./errors.js";
import {
  formatSpisZnCanonical,
  formatSpisZnCompact,
  parseSpisZn,
  splitSpisZnAndCourtQuery,
} from "./spis-zn.js";

describe("parseSpisZn", () => {
  test("accepts common compact and spaced variants", () => {
    const variants = [
      "1 T 64/2024",
      "1T64/2024",
      "1T64_2024",
      "1T64 2024",
      "1 T64/2024",
      "1 T 64 2024",
      "1 T 64 / 2024",
    ];

    for (const value of variants) {
      expect(parseSpisZn(value)).toEqual({
        bcVec: 64,
        cisloSenatu: 1,
        courtCode: undefined,
        druhVeci: "T",
        rocnik: 2024,
      });
    }
  });

  test("preserves an explicit court code embedded in the input", () => {
    expect(parseSpisZn("43 T 191/2024 OSPHA09")).toEqual({
      bcVec: 191,
      cisloSenatu: 43,
      courtCode: "OSPHA09",
      druhVeci: "T",
      rocnik: 2024,
    });

    expect(parseSpisZn("43 T 191 2024 OSPHA09")).toEqual({
      bcVec: 191,
      cisloSenatu: 43,
      courtCode: "OSPHA09",
      druhVeci: "T",
      rocnik: 2024,
    });
  });

  test("auto-detects Nejvyssi soud case types", () => {
    expect(parseSpisZn("11 TDO 123/2024")).toEqual({
      bcVec: 123,
      cisloSenatu: 11,
      courtCode: "NS",
      druhVeci: "TDO",
      rocnik: 2024,
    });
  });

  test("formats canonical and compact output consistently", () => {
    const parsed = parseSpisZn("1T64_2024");

    expect(formatSpisZnCanonical(parsed)).toBe("1 T 64/2024");
    expect(formatSpisZnCompact(parsed)).toBe("1T64_2024");
  });

  test("rejects trailing uppercase court-name tails that are not real court codes", () => {
    expect(() => parseSpisZn("4 T 21/2025 MELNIK")).toThrow(
      InfoSoudParseError,
    );
  });
});

describe("splitSpisZnAndCourtQuery", () => {
  test("extracts a trailing free-form court query from the same argument", () => {
    expect(splitSpisZnAndCourtQuery("4 T 21/2025 melnik")).toEqual({
      courtQuery: "melnik",
      spisZn: "4 T 21/2025",
    });

    expect(splitSpisZnAndCourtQuery("4 T 21 2025 melnik")).toEqual({
      courtQuery: "melnik",
      spisZn: "4 T 21 2025",
    });
  });

  test("leaves plain spisova znacka untouched", () => {
    expect(splitSpisZnAndCourtQuery("1T64_2024")).toEqual({
      courtQuery: undefined,
      spisZn: "1T64_2024",
    });
  });
});
