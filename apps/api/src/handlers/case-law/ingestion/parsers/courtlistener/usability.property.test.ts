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
const readableSentence = fc.oneof(
  fc
    .tuple(
      fc.constantFrom("order", "judgment", "decree", "decision"),
      fc.constantFrom("vacated", "remanded", "reversed", "modified", "quashed"),
      fc.constantFrom(".", " with directions.", " after review."),
    )
    .map(([subject, verb, ending]) => `The ${subject} is ${verb}${ending}`),
  fc
    .tuple(
      fc.constantFrom("The garden", "A small bird", "The afternoon sky"),
      fc.constantFrom("appears bright", "looks peaceful", "remains quiet"),
      fc.constantFrom(" today.", " in the morning.", " during the summer."),
    )
    .map(([subject, predicate, ending]) => `${subject} ${predicate}${ending}`),
);

const metadataHeader = fc.oneof(
  fc
    .tuple(
      fc.integer({ min: 10, max: 99 }),
      fc.integer({ min: 1, max: 99_999 }),
      fc.integer({ min: 1, max: 40 }),
    )
    .map(
      ([year, docket, page]) =>
        `Case: ${year}-${docket} Date Filed: 01/01/2024 Page: ${page} of 40`,
    ),
  fc.constantFrom(
    "Office of the Attorney General",
    "United States Court of Appeals for the Second Circuit",
    "Mr. Justice Zqhr delivered the opinion of the court.",
    "Judge Zqhr took no part.",
    "2024 PA Super 123",
    "January 1, 2024",
  ),
);

const publisherPlaceholder = fc.constantFrom(
  ...shortTexts
    .filter(({ expected }) => expected === "source-placeholder")
    .flatMap(({ texts }) => texts),
);
const classificationBlock = fc.oneof(
  metadataHeader.map((text) => ({ type: "metadata" as const, text })),
  publisherPlaceholder.map((text) => ({ type: "placeholder" as const, text })),
  ruling.map((text) => ({ type: "ruling" as const, text })),
);

test(
  "CourtListener metadata and placeholder block mixes classify by their ruling content",
  () => {
    assertProperty(
      "CourtListener metadata and placeholder block mixes classify by their ruling content",
      fc.property(
        fc.array(classificationBlock, { minLength: 1, maxLength: 24 }),
        fc.constantFrom("\n", "\n\n", "\r\n\r\n"),
        (blocks, separator) => {
          const body = blocks.map(({ text }) => text).join(separator);
          if (blocks.some(({ type }) => type === "ruling")) {
            expect(classifyCourtListenerText(body)).toBe("usable");
            return;
          }
          const expected = blocks.some(({ type }) => type === "placeholder")
            ? "source-placeholder"
            : "no-ruling-text";
          expect(classifyCourtListenerText(body)).toBe(expected);
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "CourtListener metadata sequences contain no ruling until a ruling block is added",
  () => {
    assertProperty(
      "CourtListener metadata sequences contain no ruling until a ruling block is added",
      fc.property(
        fc.array(metadataHeader, { minLength: 1, maxLength: 40 }),
        fc.constantFrom("\n", "\n\n", "\r\n\r\n"),
        readableSentence,
        fc.nat(),
        (headers, separator, sentence, position) => {
          const body = headers.join(separator);
          expect(classifyCourtListenerText(body)).toBe("no-ruling-text");
          const insertion = position % (headers.length + 1);
          const withRuling = [
            ...headers.slice(0, insertion),
            sentence,
            ...headers.slice(insertion),
          ].join(separator);
          expect(classifyCourtListenerText(withRuling)).toBe("usable");
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test("CourtListener long body without sentence breaks classifies within the normal test time", () => {
  expect(classifyCourtListenerText("a".repeat(100_000))).toBe("usable");
});

test(
  "CourtListener readable sentences make every nonusable short body usable",
  () => {
    assertProperty(
      "CourtListener readable sentences make every nonusable short body usable",
      fc.property(readableSentence, (sentence) => {
        expect(classifyCourtListenerText(sentence)).toBe("usable");
        const suffix = `\n\n${sentence}`;
        for (const { expected, texts } of shortTexts) {
          if (expected === "usable") {
            continue;
          }
          for (const text of texts) {
            const appended = `${text}${suffix}`;
            expect(expected).toBe(classifyCourtListenerText(text));
            expect(classifyCourtListenerText(appended)).toBe("usable");
            const restored = appended.slice(0, -suffix.length);
            expect(restored).toBe(text);
            expect(expected).toBe(classifyCourtListenerText(restored));
          }
        }
      }),
    );
  },
  propertyTestTimeout(10_000),
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

const withdrawalRelatedProse = [
  "This opinion concerns a motion",
  "The court's opinion discusses a motion",
  "This opinion explains why the prior order",
  "The opinion describes how the application",
].flatMap((subject) =>
  [
    "that was withdrawn",
    "that has been withdrawn",
    "was withdrawn",
    "was never issued",
    "has not been issued",
  ].flatMap((clause) =>
    [".", " after review.", " by the lower court."].map(
      (ending) => `${subject} ${clause}${ending}`,
    ),
  ),
);

test.each(withdrawalRelatedProse)(
  "CourtListener preserves readable prose about withdrawn or unissued matters: %s",
  (text) => {
    expect(classifyCourtListenerText(text)).toBe("usable");
  },
);
