import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig } from "@stll/property-testing";

import {
  PlainTextError,
  type PlainText,
  toPlainText,
  toPlainTextMetadata,
} from "@/api/lib/case-law/plain-text";
import { containsTagLikeMarkup } from "@/api/lib/case-law/plain-text-markup";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
    ['<span title="30 days > deadline">Court</span>', "Court"],
    ["<span title='claim < limit'>Court</span>", "Court"],
    ["<![CDATA[Sąd Najwyższy]]>", "Sąd Najwyższy"],
    ["&amp;lt;p&amp;gt;Kúria&amp;lt;/p&amp;gt;", "Kúria"],
    ["&quot;Supreme Court&quot; &#x26; &#38;", '"Supreme Court" & &'],
    ["<?xml version='1.0'?><b>Bundesgerichtshof</b>", "Bundesgerichtshof"],
    ["one\r\n\r\n\r\n two\t words", "one\n\ntwo words"],
    ["<sp<span>an>hidden</span>", "hidden"],
  ])("normalizes %s", (raw, expected) => {
    expect(toPlainText(raw).unwrap() === expected).toBe(true);
  });

  test.each(["{\\rtf1\\ansi court}", "court \\'e8", "\\par court"])(
    "rejects undecodable syntax %s",
    (raw) => {
      const result = toPlainText(raw);
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(PlainTextError);
        expect(result.error.reason).toBe("rtf-syntax");
      }
    },
  );

  test("malformed runtime input returns a typed decoding failure", () => {
    const result = toPlainText(asTestRaw<string>(null));
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(PlainTextError);
      expect(result.error.reason).toBe("entity-decode-failed");
    }
  });

  test("a public brand name cannot construct the private plain-text proof", () => {
    const publicBrand = v.parse(
      v.pipe(v.string(), v.brand("PlainText")),
      "Court",
    );
    // @ts-expect-error Only the private sanitizer brand satisfies PlainText.
    const forged: PlainText = publicBrand;
    expect(forged.toString()).toBe("Court");
  });

  test("normalizes every nested metadata string while preserving JSON scalars", () => {
    expect(
      Bun.deepEquals(
        toPlainTextMetadata({
          labels: ["<b>Soud</b>", { label: "&amp;lt;br/&amp;gt;Court" }],
          count: 5,
          enabled: false,
          missing: null,
        }).unwrap(),
        {
          labels: ["Soud", { label: "Court" }],
          count: 5,
          enabled: false,
          missing: null,
        },
      ),
    ).toBe(true);
    const rejected = toPlainTextMetadata(new Date());
    expect(rejected.isErr()).toBe(true);
    if (rejected.isErr()) {
      expect(rejected.error.reason).toBe("unsupported-metadata");
    }
    const nested = toPlainTextMetadata({ nested: ["court", new Date()] });
    expect(nested.isErr()).toBe(true);
    if (nested.isErr()) {
      expect(nested.error.reason).toBe("unsupported-metadata");
    }
    const encodedSyntax = toPlainTextMetadata({
      nested: ["court", "\\par broken"],
    });
    expect(encodedSyntax.isErr()).toBe(true);
    if (encodedSyntax.isErr()) {
      expect(encodedSyntax.error.reason).toBe("rtf-syntax");
    }
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
        expect(toPlainText(output).unwrap()).toBe(output);
      }),
      propertyConfig({ numRuns: 300 }),
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
            .map((character) => `&#${String(character.codePointAt(0))};`)
            .join("");
          expect(toPlainText(encoded).unwrap()).toBe(toPlainText(raw).unwrap());
        },
      ),
      propertyConfig({ numRuns: 200 }),
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
          const output = toPlainText(raw).unwrap();
          expect(containsTagLikeMarkup(output)).toBe(false);
          expect(toPlainText(output).unwrap()).toBe(output);
        },
      ),
      propertyConfig({ numRuns: 200 }),
    );
  });
});
