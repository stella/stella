import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { markupResidueIn } from "@/api/handlers/case-law/ingestion/parsers/courtlistener/markup-residue";

import { entityResidueIn } from "./entity-residue";
import { RTF_CONTROLS } from "./rtf-control-vocabulary";

const LETTERS = fc.stringMatching(/^[a-z]{2,20}$/u);
const RTF_CONTROL_WORDS = new Set<string>(
  RTF_CONTROLS.filter((control) => /^[a-z]+$/u.test(control)),
);

// Invented OCR fragments and publisher paths retain their literal wording.
test("backslashed prose and paths are not RTF controls", () => {
  for (const text of [
    String.raw`\a\ny finding in the record`,
    String.raw`\J\JS ORDER`,
    String.raw`\e\l tribunal`,
    String.raw`C:\FILES\INVENTED.135`,
    String.raw`C:\Common\Draft\Orders\Dismissal.wpd`,
    String.raw`\pictorial\pngblipper`,
  ]) {
    expect(markupResidueIn(text)).toBeUndefined();
  }
});

test("backslashed OCR fragments and publisher paths remain literal", () => {
  assertProperty(
    "backslashed OCR fragments and publisher paths remain literal",
    fc.property(LETTERS, LETTERS, (first, second) => {
      const escapedWord = `\\a\\${second} finding`;
      expect(escapedWord).toMatch(/\\[a-z]+\\[a-z]+/u);
      expect(markupResidueIn(escapedWord)?.rule).toBe(
        RTF_CONTROL_WORDS.has(second) ? "rtf-control" : undefined,
      );

      const path = `C:\\directory${first}\\document${second}.wpd`;
      expect(path).toMatch(/\\[a-z]+\\[a-z]+/u);
      expect(markupResidueIn(path)).toBeUndefined();
    }),
  );
});

test("a known control word after an unknown control is residue", () => {
  expect(markupResidueIn(String.raw`\a\ab finding`)?.rule).toBe("rtf-control");
});

test("real RTF groups and control sequences are detected", () => {
  for (const text of [
    String.raw`{\rtf1 text}`,
    String.raw`{\*\inventeddestination text}`,
    String.raw`\pard\plain text`,
    String.raw`\b\i text`,
    String.raw`\pict\pngblip payload`,
    String.raw`\shppict \pict\picprop\shplid25`,
    String.raw`\a\noise\pict\pngblip payload`,
  ]) {
    expect(markupResidueIn(text)?.rule).toBe("rtf-control");
  }
});

test("RTF controls remain detectable across parameters and group separators", () => {
  assertProperty(
    "RTF controls remain detectable across parameters and group separators",
    fc.property(
      fc.integer({ min: -32_768, max: 32_767 }),
      fc.constantFrom("", " ", "\n", "}{", " \t{}"),
      (parameter, separator) => {
        expect(
          markupResidueIn(`before \\picw${parameter}${separator}\\pich32 after`)
            ?.rule,
        ).toBe("rtf-control");
      },
    ),
  );
});

test("markup entity detection shares the complete HTML5 token grammar", () => {
  assertProperty(
    "markup entity detection shares the complete HTML5 token grammar",
    fc.property(
      fc.constantFrom(
        "&CounterClockwiseContourIntegral;",
        "&NotNestedGreaterGreater;",
        "&frac12;",
        "&commat;",
        "&#x1F642;",
        "&#X0000FD;",
        "&#000000000253;",
        "&inventedPublisherLiteral;",
      ),
      LETTERS,
      (reference, prefix) => {
        const text = `${prefix} ${reference} after`;
        const expected = entityResidueIn(text);
        const detected = markupResidueIn(text);
        expect(detected?.rule).toBe(expected ? "entity" : undefined);
        if (expected) {
          expect(detected?.excerpt.startsWith(reference)).toBe(true);
        }
      },
    ),
  );
});

test("citation URL hashes and explicit wallet addresses remain literal", () => {
  const hash = "a1b2c3d4".repeat(4);
  expect(
    markupResidueIn(`https://example.test/article/${hash}.`),
  ).toBeUndefined();
  expect(
    markupResidueIn(`https://example.test/article/invented-\n${hash}.`),
  ).toBeUndefined();
  expect(
    markupResidueIn(`WALLET OWNER 0x${"abcd1234".repeat(5)},`),
  ).toBeUndefined();
  expect(
    markupResidueIn(`WALLET OWNER 0x${"12345678".repeat(5)},`),
  ).toBeUndefined();
});

test("identifier context does not hide later binary payloads", () => {
  const payload = "abc12345".repeat(6);
  for (const text of [
    payload,
    `0x${payload}`,
    `https://example.test/article\n${payload}`,
    `https://example.test/article/a1b2 ${payload}`,
    `https://example.test/${payload} citation\n${payload}`,
    `0x${"abcd1234".repeat(5)} citation\n${payload}`,
    `prefix0x${"abcd1234".repeat(5)}`,
    `Wallet Owner x${"abcd1234".repeat(5)}`,
  ]) {
    expect(markupResidueIn(text)?.rule).toBe("hex-run");
  }
});

test("hex identifiers remain literal only inside citation or wallet syntax", () => {
  assertProperty(
    "hex identifiers remain literal only inside citation or wallet syntax",
    fc.property(
      fc.array(fc.constantFrom("a", "b", "c", "d", "e", "f", "1", "2"), {
        minLength: 39,
        maxLength: 39,
      }),
      fc.constantFrom("", "\n", "\r\n"),
      (digits, newline) => {
        const hash = `a${digits.join("")}`;
        expect(markupResidueIn(hash)?.rule).toBe("hex-run");
        expect(markupResidueIn(`Owner 0x${hash},`)).toBeUndefined();
        expect(markupResidueIn(`Wallet Owner x${hash},`)?.rule).toBe("hex-run");
        expect(
          markupResidueIn(`https://example.test/invented-${newline}${hash}`),
        ).toBeUndefined();
        expect(
          markupResidueIn(
            `https://example.test/invented-${newline}${hash} text ${hash}`,
          )?.rule,
        ).toBe("hex-run");
      },
    ),
  );
});
