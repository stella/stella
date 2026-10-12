import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { normalizeUnicode } from "@stll/text-normalize";

import { foldStatuteQuery, parseStatuteQuery } from "./statute-query-intent";

const number = fc.integer({ min: 1, max: 99_999 });
const year = fc.integer({ min: 1800, max: 2099 });

const operators = fc.constantFrom(
  "AND",
  "OR",
  "NOT",
  ":",
  "*",
  "~",
  "(",
  ")",
  "+",
  "-",
  "\\",
  '"',
  "'",
  "§",
  "—",
  "„",
  "”",
);

const adversarialText = fc
  .tuple(
    fc.array(operators, { minLength: 1, maxLength: 5 }),
    fc.stringMatching(/^[a-z]{3,10}$/u),
    fc.array(operators, { minLength: 1, maxLength: 5 }),
  )
  .map(([before, word, after]) => `${before.join("")}${word}${after.join("")}`);

describe("statute query parser properties", () => {
  test(
    "canonical Czech and Slovak act values parse back to the same act",
    () => {
      assertProperty(
        "canonical Czech and Slovak act values parse back to the same act",
        fc.property(
          number,
          year,
          fc.constantFrom(
            { country: "cze", suffix: "", collection: "sb" } as const,
            { country: "cze", suffix: " Sb.", collection: "sb" } as const,
            { country: "svk", suffix: "", collection: "zz" } as const,
            { country: "svk", suffix: " Z. z.", collection: "zz" } as const,
          ),
          (n, y, { country, suffix, collection }) => {
            const parsed = parseStatuteQuery(country, `${n}/${y}${suffix}`);
            expect(parsed).toEqual({
              type: "act",
              collection,
              label: null,
              number: String(n),
              provision: null,
              year: String(y),
            });
            if (parsed.type === "act") {
              expect(
                parseStatuteQuery(
                  country,
                  `${parsed.number}/${parsed.year}${suffix}`,
                ),
              ).toEqual(parsed);
            }
          },
        ),
      );
    },
    propertyTestTimeout(10_000),
  );

  test(
    "operator shaped unrecognized entries remain intact title text",
    () => {
      assertProperty(
        "operator shaped unrecognized entries remain intact title text",
        fc.property(adversarialText, (text) => {
          expect(parseStatuteQuery("cze", text)).toEqual({
            type: "text",
            text,
          });
          expect(parseStatuteQuery("svk", text)).toEqual({
            type: "text",
            text,
          });
        }),
      );
    },
    propertyTestTimeout(10_000),
  );
});

test(
  "provisions retain their designation while paragraph and letter do not change the act",
  () => {
    assertProperty(
      "provisions retain their designation while paragraph and letter do not change the act",
      fc.property(
        number,
        year,
        fc.integer({ min: 1, max: 9999 }),
        (n, y, section) => {
          for (const country of ["cze", "svk"] as const) {
            const suffix = country === "cze" ? "Sb." : "Z. z.";
            for (const [marker, expected] of [
              ["§", "§"],
              ["par.", "par."],
              ["čl.", "cl."],
              ["art.", "art."],
            ] as const) {
              for (const qualifier of [
                "",
                " odst. 2",
                " písm. b)",
                " odst. 2 písm. b)",
              ]) {
                const text = `${marker} ${section}a${qualifier} zákona č. ${n}/${y} ${suffix}`;
                expect(parseStatuteQuery(country, text)).toEqual({
                  type: "act",
                  collection: country === "cze" ? "sb" : "zz",
                  label: null,
                  number: String(n),
                  year: String(y),
                  provision: `${expected} ${section}a`,
                });
              }
            }
          }
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "collections from the other jurisdiction stay verbatim title searches",
  () => {
    assertProperty(
      "collections from the other jurisdiction stay verbatim title searches",
      fc.property(number, year, (n, y) => {
        for (const [country, suffixes] of [
          ["cze", ["Zb.", "Z. z."]],
          ["svk", ["Sb.", "Ú. l.", "Ú. l. II"]],
        ] as const) {
          for (const suffix of suffixes) {
            for (const prefix of ["", "§ 3 ", "zákon č. "]) {
              const text = `${prefix}${n}/${y} ${suffix}`;
              expect(parseStatuteQuery(country, `  ${text}  `)).toEqual({
                type: "text",
                text,
              });
            }
          }
        }
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "act number widths reject near misses and normalize permitted zero padding",
  () => {
    assertProperty(
      "act number widths reject near misses and normalize permitted zero padding",
      fc.property(fc.integer({ min: 1, max: 999 }), year, (n, y) => {
        for (const country of ["cze", "svk"] as const) {
          const valid = parseStatuteQuery(country, `${n}/${y}`);
          expect(
            parseStatuteQuery(country, `${String(n).padStart(5, "0")}/${y}`),
          ).toEqual(valid);
          for (const text of [
            `${String(n).padStart(6, "0")}/${y}`,
            `${n}/${String(y).slice(1)}`,
            `${n}/${y}0`,
            `${n}/${y}/1`,
            `text ${n}/${y}`,
            `${n}/${y} text`,
          ]) {
            expect(parseStatuteQuery(country, text)).toEqual({
              type: "text",
              text,
            });
          }
        }
      }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "folding is a fixed point across decomposed diacritics and compatibility characters",
  () => {
    assertProperty(
      "folding is a fixed point across decomposed diacritics and compatibility characters",
      fc.property(
        fc.constantFrom(
          "Občanský zákoník",
          "Občiansky zákonník",
          "čl. ３ ÚSTAVA",
          "§ ２０７９ zákona č. ０８９／２０１２ Sb.",
        ),
        fc.constantFrom("\t", "\n", "\u00a0", "\u202f"),
        (text, gap) => {
          const spelling = `${gap}${normalizeUnicode(text, "NFD").replaceAll(" ", () => gap)}${gap}`;
          expect(spelling).not.toBe(text);
          const folded = foldStatuteQuery(text);
          expect(foldStatuteQuery(spelling)).toBe(folded);
          expect(foldStatuteQuery(folded)).toBe(folded);
          for (const country of ["cze", "svk"] as const) {
            const intent = parseStatuteQuery(country, text);
            if (intent.type === "act") {
              expect(parseStatuteQuery(country, spelling)).toEqual(intent);
            }
          }
        },
      ),
    );
  },
  propertyTestTimeout(10_000),
);
