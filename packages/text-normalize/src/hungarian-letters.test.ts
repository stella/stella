import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { restoreHungarianLetters } from "./hungarian-letters.js";

describe("restoreHungarianLetters", () => {
  test("reads the Latin-1 stand-ins as the Hungarian letters", () => {
    expect(
      restoreHungarianLetters("illetõleg, ÕSZI szerzõdés, bûnös, BÛNÖS"),
    ).toBe("illetőleg, ŐSZI szerződés, bűnös, BŰNÖS");
  });

  test("a stand-in written through windows-1252 reads as the windows-1250 letter", () => {
    // The fold is the pair it repairs: each stand-in is the byte of its letter
    // in windows-1250, read as windows-1252.
    for (const letter of ["ő", "Ő", "ű", "Ű"]) {
      const byte = [...Array.from({ length: 256 }, (_, index) => index)].find(
        (candidate) =>
          new TextDecoder("windows-1250").decode(Uint8Array.of(candidate)) ===
          letter,
      );
      const standIn = new TextDecoder("windows-1252").decode(
        Uint8Array.of(byte ?? 0),
      );
      expect(restoreHungarianLetters(standIn)).toBe(letter);
    }
  });

  test("leaves every other character as it is, and is idempotent", () => {
    assertProperty(
      "leaves every other character as it is, and is idempotent",
      fc.property(
        fc
          .array(
            fc.oneof(
              fc.constantFrom("õ", "Õ", "û", "Û", "ő", "Ű", "o", "u"),
              fc.string({ unit: "grapheme", maxLength: 4 }),
            ),
            { maxLength: 20 },
          )
          .map((pieces) => pieces.join("")),
        (text) => {
          const restored = restoreHungarianLetters(text);
          expect(restored).not.toMatch(/[õÕûÛ]/u);
          expect(restored.length).toBe(text.length);
          expect(restoreHungarianLetters(restored)).toBe(restored);
          const kept = [...text].filter((letter) => !/[õÕûÛ]/u.test(letter));
          expect(
            [...restored].filter((letter) => !/[őŐűŰ]/u.test(letter)),
          ).toEqual(kept.filter((letter) => !/[őŐűŰ]/u.test(letter)));
        },
      ),
      { numRuns: 300 },
    );
  });
});
