import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  PlainTextError,
  requirePlainText,
  toPlainText,
  toPlainTextMetadata,
} from "@/api/lib/case-law/plain-text";
import { containsTagLikeMarkup } from "@/api/lib/case-law/plain-text-markup";

describe("plain text preserves publisher wording without presentation syntax", () => {
  test.each([
    ["a < b", "a < b"],
    ["§ 5 < 3", "§ 5 < 3"],
    ["x<y", "x<y"],
    ["<-", "<-"],
    ["<p\u00a0>", "<p\u00a0>"],
    ["<p\uFEFF>", "<p\uFEFF>"],
    [
      "<span class='court'>Nejvyšší soud</span><br/>Česká republika",
      "Nejvyšší soud Česká republika",
    ],
    ["<p>Najvyšší súd</p><!-- poznámka -->", "Najvyšší súd"],
    ["<![CDATA[Sąd Najwyższy]]>", "Sąd Najwyższy"],
    ["&amp;lt;p&amp;gt;Kúria&amp;lt;/p&amp;gt;", "Kúria"],
    ["&quot;Supreme Court&quot; &#x26; &#38;", '"Supreme Court" & &'],
    ["<?xml version='1.0'?><b>Bundesgerichtshof</b>", "Bundesgerichtshof"],
    ["one\r\n\r\n\r\n two\t words", "one\n\ntwo words"],
    ["<sp<span>an>hidden</span>", "hidden"],
  ])("normalizes %s", (raw, expected) => {
    expect(requirePlainText(raw)).toBe(expected);
  });

  test.each(["{\\rtf1\\ansi court}", "court \\'e8", "\\par court"])(
    "rejects undecodable syntax %s",
    (raw) => {
      expect(() => requirePlainText(raw)).toThrow(PlainTextError);
    },
  );

  test("normalizes every nested metadata string while preserving JSON scalars", () => {
    expect(
      toPlainTextMetadata({
        labels: ["<b>Soud</b>", { label: "&amp;lt;br/&amp;gt;Court" }],
        count: 5,
        enabled: false,
        missing: null,
      }),
    ).toEqual({
      labels: ["Soud", { label: "Court" }],
      count: 5,
      enabled: false,
      missing: null,
    });
    expect(() => toPlainTextMetadata(new Date())).toThrow(PlainTextError);
  });

  test("successful output is a markup-free fixed point over arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = toPlainText(raw);
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(PlainTextError);
          return;
        }
        const output = result.value;
        expect(containsTagLikeMarkup(output)).toBe(false);
        expect(requirePlainText(output)).toBe(output);
      }),
      { numRuns: 300 },
    );
  });

  test("numeric entity encodings round trip language-blind publisher text", () => {
    const letter = fc.constantFrom(
      ..."Český Najvyšší Sąd Kúria Supreme Bundesgerichtshof 東京 المحكمة".split(
        "",
      ),
    );
    fc.assert(
      fc.property(
        fc.array(letter, { minLength: 1, maxLength: 80 }),
        (letters) => {
          const raw = letters.join("");
          const encoded = letters
            .map((character) => `&#${character.codePointAt(0)};`)
            .join("");
          expect(requirePlainText(encoded)).toBe(requirePlainText(raw));
        },
      ),
      { numRuns: 200 },
    );
  });

  test("contract-recognized structures cannot survive nested encoding or removal", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "<br>",
          "<br/>",
          "<span x='y'>",
          "</p>",
          "<!--",
          "<![CDATA[",
          "<?xml",
        ),
        fc.integer({ min: 0, max: 12 }),
        (tag, depth) => {
          let raw = `${tag}court`;
          for (let index = 0; index < depth; index++) {
            raw = raw
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;");
          }
          const output = requirePlainText(raw);
          expect(containsTagLikeMarkup(output)).toBe(false);
          expect(requirePlainText(output)).toBe(output);
        },
      ),
      { numRuns: 200 },
    );
  });
});
