import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { graphemesOf, splitForMiddleTruncate } from "./middle-truncate.logic";

// Word characters, the break characters the split snaps to, and graphemes
// built from several code points (a combining mark, a joined emoji, a flag).
const nameCharacter = fc.constantFrom(
  "a",
  "ž",
  "ي",
  "7",
  " ",
  "-",
  "_",
  ".",
  "/",
  "é",
  "👩‍⚖️",
  "🇨🇿",
);
const name = fc
  .array(nameCharacter, { maxLength: 60 })
  .map((characters) => characters.join(""));

describe("splitForMiddleTruncate", () => {
  test("keeps every value whole and cuts only between graphemes", () => {
    assertProperty(
      "keeps every value whole and cuts only between graphemes",
      fc.property(name, (value) => {
        const split = splitForMiddleTruncate(value);
        if (split === null) {
          return graphemesOf(value).length < 14;
        }
        const tail = graphemesOf(split.tail).length;
        return (
          split.head + split.tail === value &&
          [...graphemesOf(split.head), ...graphemesOf(split.tail)].join(
            "\u0000",
          ) === graphemesOf(value).join("\u0000") &&
          tail >= 4 &&
          tail <= 16 &&
          graphemesOf(split.head).length >= 4
        );
      }),
      { numRuns: 500 },
    );
  });

  test("starts the tail on a word", () => {
    expect(
      splitForMiddleTruncate("Smlouva o dílo – revize klienta.docx"),
    ).toEqual({ head: "Smlouva o dílo – revize ", tail: "klienta.docx" });
    expect(splitForMiddleTruncate("t3/clone-repo-on-remote-machine")).toEqual({
      head: "t3/clone-repo-on-remote-",
      tail: "machine",
    });
  });

  test("leaves short values whole", () => {
    expect(splitForMiddleTruncate("Smlouva.docx")).toBeNull();
  });
});
