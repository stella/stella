import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { snippetCitation } from "./snippet-citation";

test("snippet citation offsets only identify an unambiguous exact printed span", () => {
  assertProperty(
    "snippet citation offsets only identify an unambiguous exact printed span",
    fc.property(
      fc.array(fc.constantFrom("a", " ", "😀", "ě", "ع", "\n"), {
        maxLength: 30,
      }),
      fc.array(fc.constantFrom("a", " ", "😀", "ě", "ع", "\n"), {
        maxLength: 30,
      }),
      (prefix, suffix) => {
        const print = "§ 13";
        const text = prefix.join("") + print + suffix.join("");
        const range = snippetCitation(text, print);
        expect(range).toEqual({
          start: prefix.join("").length,
          end: prefix.join("").length + print.length,
        });
        expect(text.slice(range?.start, range?.end)).toBe(print);
        expect(snippetCitation(text + print, print)).toBeNull();
        expect(snippetCitation(text, "§ 14")).toBeNull();
        expect(snippetCitation(null, print)).toBeNull();
        expect(snippetCitation(text, null)).toBeNull();
        expect(snippetCitation(text, "")).toBeNull();
      },
    ),
  );
});

test("literal citation uniqueness includes overlaps, punctuation and exact Czech spelling", () => {
  expect(snippetCitation("aaa", "aa")).toBeNull();
  expect(snippetCitation("😀 Novákové, a.b; axb", "a.b")).toEqual({
    start: 13,
    end: 16,
  });
  expect(snippetCitation("😀 Novákové", "Novákové")).toEqual({
    start: 3,
    end: 11,
  });
  for (const print of ["novákové", "Novakove", "Nováková"]) {
    expect(snippetCitation("😀 Novákové", print)).toBeNull();
  }
});

test("literal citation matcher agrees with exact scalar substring uniqueness", () => {
  assertProperty(
    "literal citation matcher agrees with exact scalar substring uniqueness",
    fc.property(
      fc.array(fc.constantFrom("a", "b", ".", " ", "ě", "😀", "Novákové"), {
        maxLength: 24,
      }),
      fc.array(fc.constantFrom("a", "b", ".", " ", "ě", "😀", "Novákové"), {
        maxLength: 8,
      }),
      (units, needleUnits) => {
        const sentence = units.join("");
        const needle = needleUnits.join("");
        const at = sentence.indexOf(needle);
        const expected =
          needle === "" || at === -1 || sentence.includes(needle, at + 1)
            ? null
            : { start: at, end: at + needle.length };
        expect(snippetCitation(sentence, needle)).toEqual(expected);
      },
    ),
  );
});

test("citation literals match Unicode scalars after replacing isolated surrogates", () => {
  expect(snippetCitation("x\ud801y", "\ud800")).toEqual({ start: 1, end: 2 });
  expect(snippetCitation("😀", "\ud83d")).toBeNull();
  expect(snippetCitation("😀", "\ude00")).toBeNull();
});
