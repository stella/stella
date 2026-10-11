import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { canonicalUsReporterCitation } from "@stll/api-contract/us-reporter-citation";
import {
  assertProperty,
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { US_REPORTER_SPELLINGS } from "../../../../../../packages/api-contract/src/us-reporter-editions.generated";
import { scanRun, US_CITATION_WORK_LIMIT } from "./us-citation-scanner";

const noise = fc
  .array(
    fc.constantFrom("x", "č", "😀", " ", "\u00a0", "\u2003", "/", "§", "9"),
    { maxLength: 60 },
  )
  .map((parts) => parts.join(""));
const reporter = fc
  .tuple(
    fc.integer({ min: 1, max: 999 }),
    fc.constantFrom("U.S.", "F.3d", "S. Ct."),
    fc.integer({ min: 1, max: 9999 }),
  )
  .map(
    ([volume, edition, page]) => `${String(volume)} ${edition} ${String(page)}`,
  );
const scan = (text: string, limit = US_CITATION_WORK_LIMIT) => {
  const budget = { limit, spent: 0 };
  const result = scanRun([{ type: "text", text }], {
    budget,
    identityKey: ({ value }) => value,
  });
  return { result, budget };
};

test("every unambiguous reporter spelling scans to its parsed identity", () => {
  const spellings = Object.keys(US_REPORTER_SPELLINGS).filter(
    (spelling) => canonicalUsReporterCitation(`137 ${spelling} 246`) !== null,
  );
  const assertIdentity = (text: string) => {
    const canonical = canonicalUsReporterCitation(text);
    if (canonical === null) {
      panic("Generated reporter citation has no canonical identity");
    }
    const { result } = scan(text);
    if (Result.isError(result)) {
      throw result.error;
    }
    expect(
      result.value.events.flatMap((event) =>
        event.kind === "token" && event.token.kind === "full"
          ? [event.token.base?.identifier.value]
          : [],
      ),
    ).toEqual([canonical]);
    const parallel = scan(`319 U.S. 527, ${text}`).result;
    if (Result.isError(parallel)) {
      throw parallel.error;
    }
    expect(
      parallel.value.events.flatMap((event) =>
        event.kind === "token" && event.token.kind === "full"
          ? [event.token.base?.identifier.value]
          : [],
      ),
    ).toEqual(["319 U.S. 527", canonical]);
    const short = scan(
      `319 U.S. 527, ${text.replace(/\s+\d+$/u, ", at 891")}`,
    ).result;
    if (Result.isError(short)) {
      throw short.error;
    }
    expect(
      short.value.events.flatMap((event) =>
        event.kind === "token" ? [event.token.kind] : [],
      ),
    ).toEqual(["full", "volume-reporter"]);
  };
  for (const spelling of spellings) {
    assertIdentity(`137 ${spelling} 246`);
  }
  assertProperty(
    "every unambiguous reporter spelling scans to its parsed identity",
    fc.property(
      fc.constantFrom(...spellings),
      fc.integer({ min: 1, max: 9999 }),
      fc.integer({ min: 1, max: 99_999 }),
      fc.constantFrom(" ", "   ", "\r\n  ", "\u00a0\u00a0\u00a0"),
      (spelling, volume, page, gap) => {
        assertIdentity(
          `${String(volume)}${gap}${spelling}${gap}${String(page)}`,
        );
      },
    ),
  );
});

test(
  "reporter tokens retain their source spans under a prefix",
  () => {
    fc.assert(
      fc.property(
        noise,
        reporter,
        noise,
        noise,
        (before, citation, after, prefix) => {
          const text = `${before}; ${citation}; ${after}`;
          const lead = `${prefix}; `;
          const original = scan(text).result;
          const shifted = scan(lead + text).result;
          if (Result.isError(original)) {
            throw original.error;
          }
          if (Result.isError(shifted)) {
            throw shifted.error;
          }
          expect(original.value.text).toBe(text);
          const tokens = original.value.events.flatMap((event) =>
            event.kind === "token" ? [event.token] : [],
          );
          expect(
            tokens.some(
              (token) => text.slice(token.start, token.end) === citation,
            ),
          ).toBe(true);
          for (const token of tokens) {
            expect(token.start).toBeGreaterThanOrEqual(0);
            expect(token.end).toBeGreaterThan(token.start);
            expect(token.end).toBeLessThanOrEqual(text.length);
            if (token.kind !== "barrier" && token.pin?.type === "pin") {
              expect(text.slice(token.start, token.end)).toContain(
                token.pin.raw,
              );
            }
          }
          const shiftedTokens = shifted.value.events.flatMap((event) =>
            event.kind === "token" && event.token.start >= lead.length
              ? [
                  {
                    ...event.token,
                    start: event.token.start - lead.length,
                    end: event.token.end - lead.length,
                  },
                ]
              : [],
          );
          expect(shiftedTokens).toEqual(tokens);
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "candidate production stops immediately past its work allowance",
  () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom("Id. ", "§ 123 ", "1 XYZ 2. ", "2020 WL 1. "),
        (limit, extra, fragment) => {
          const { result, budget } = scan(
            fragment.repeat(limit + extra),
            limit,
          );
          expect(Result.isError(result)).toBe(true);
          if (Result.isOk(result)) {
            return;
          }
          expect(result.error._tag).toBe("UsCitationWorkBudgetError");
          expect(result.error.limit).toBe(limit);
          expect(budget.spent).toBe(limit + 1);
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "long separator and digit runs stay bounded",
  () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "/",
          "9",
          "§",
          "\u00a0",
          "\u2003",
          " , / ",
          "1 U.S. 2, ",
        ),
        fc.integer({ min: 1000, max: 12_000 }),
        (fragment, count) => {
          const text = `${fragment.repeat(count)}; 410 U.S. 113`;
          const started = performance.now();
          const { result, budget } = scan(text);
          expect(performance.now() - started).toBeLessThan(2000);
          expect(budget.spent).toBeLessThanOrEqual(US_CITATION_WORK_LIMIT + 1);
          if (Result.isError(result)) {
            expect(result.error._tag).toBe("UsCitationWorkBudgetError");
            expect(budget.spent).toBeGreaterThan(US_CITATION_WORK_LIMIT);
            return;
          }
          expect(
            result.value.events.some(
              (event) =>
                event.kind === "token" &&
                text.slice(event.token.start, event.token.end) ===
                  "410 U.S. 113",
            ),
          ).toBe(true);
        },
      ),
      propertyConfig({ numRuns: 20, seed: propertySeed() }),
    );
  },
  propertyTestTimeout(15_000),
);
