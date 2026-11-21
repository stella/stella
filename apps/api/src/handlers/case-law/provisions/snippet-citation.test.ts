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
