import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import shortTexts from "./short-text.test-fixture.json";
import { classifyCourtListenerText } from "./usability";

const whitespace = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r\n", "\u00a0"), {
    maxLength: 12,
  })
  .map((parts) => parts.join(""));
const surname = fc.constantFrom("Zqjvv", "Zqkvvv", "Zqvýl", "Z’qrlvv", "Zqhr");
const attributionSpacing = fc.constantFrom(" ", "  ", "\t", "\u00a0");
const attribution = fc
  .tuple(
    surname,
    attributionSpacing,
    fc.constantFrom("J.", "C.J.", "Judge"),
    fc.constantFrom("", ":", "."),
  )
  .map(
    ([name, spacing, title, punctuation]) =>
      `${name},${spacing}${title}${punctuation}`,
  );
const ruling = fc.constantFrom(
  "Affirmed.",
  "Denied.",
  "Granted.",
  "Dismissed.",
  "Per curiam.",
  "Reversed and remanded.",
  "It is so ordered.",
);
const date = fc
  .tuple(
    fc.integer({ min: 1, max: 12 }),
    fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 1800, max: 2099 }),
  )
  .map(([month, day, year]) => `${month}/${day}/${year}`);
const noRulingText = fc.oneof(
  fc.constantFrom(
    ...shortTexts
      .filter(({ expected }) => expected === "no-ruling-text")
      .flatMap(({ texts }) => texts),
  ),
  date,
  attribution,
  fc.integer({ min: 0, max: 999_999 }).map(String),
  fc
    .array(fc.constantFrom("(b) (6)", "(b) (7)(C)"), {
      minLength: 1,
      maxLength: 8,
    })
    .map((markers) => markers.join("\n\n")),
);
const multilingualWord = fc
  .array(
    fc.constantFrom("a", "ž", "é", "α", "ω", "ж", "я", "裁", "判", "ع", "م"),
    { minLength: 1, maxLength: 30 },
  )
  .map((letters) => letters.join(""));
const rulingSentence = fc
  .tuple(
    multilingualWord,
    fc.constantFrom("appeal", "petition", "motion", "application"),
    fc.constantFrom("denied", "granted", "dismissed", "allowed"),
    fc.constantFrom(".", ".\n", "; costs follow.", " (with costs)."),
  )
  .map(
    ([subject, proceeding, result, punctuation]) =>
      `The ${proceeding} concerning ${subject} is ${result}${punctuation}`,
  );
const usableText = fc.oneof(
  fc.constantFrom(
    ...shortTexts
      .filter(({ expected }) => expected === "usable")
      .flatMap(({ texts }) => texts),
  ),
  ruling,
  rulingSentence,
  fc
    .tuple(
      fc.constantFrom("A", "B", "C", "X"),
      fc.integer({ min: 1, max: 999 }),
    )
    .map(([letter, number]) => `We deny ${letter}${number}.`),
  fc.tuple(ruling, ruling).map(([first, second]) => `${first}\n\n${second}`),
);

test(
  "CourtListener ruling words make non-ruling bodies usable",
  () => {
    assertProperty(
      "CourtListener ruling words make non-ruling bodies usable",
      fc.property(
        noRulingText,
        ruling,
        whitespace,
        (body, decision, spacing) => {
          expect(classifyCourtListenerText(body)).toBe("no-ruling-text");
          expect(
            classifyCourtListenerText(`${body}\n\n${spacing}${decision}`),
          ).toBe("usable");
          expect(
            classifyCourtListenerText(`${decision}${spacing}\n\n${body}`),
          ).toBe("usable");
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "CourtListener usable bodies remain usable with whitespace and attribution",
  () => {
    assertProperty(
      "CourtListener usable bodies remain usable with whitespace and attribution",
      fc.property(
        usableText,
        whitespace,
        whitespace,
        attribution,
        attribution,
        (body, before, after, opening, closing) => {
          expect(classifyCourtListenerText(body)).toBe("usable");
          expect(classifyCourtListenerText(`${before}${body}${after}`)).toBe(
            "usable",
          );
          expect(
            classifyCourtListenerText(
              `${before}${opening}\n\n${body}\n\n${closing}${after}`,
            ),
          ).toBe("usable");
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);
