import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  canonicalUsReporterCitation,
  US_REPORTER_PAGE_LEAD_SOURCE,
} from "@stll/api-contract/us-reporter-citation";
import {
  assertProperty,
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

const FIRST_PAGE_RE = new RegExp(
  String.raw`${US_REPORTER_PAGE_LEAD_SOURCE}\d{1,5}$`,
  "u",
);

test("every unambiguous reporter spelling scans to its parsed identity", () => {
  const spellings = Object.keys(US_REPORTER_SPELLINGS).filter(
    (spelling) => canonicalUsReporterCitation(`9137 ${spelling} 9246`) !== null,
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
    const pageMarker = scan(`${text} p. 9975`).result;
    if (Result.isError(pageMarker)) {
      throw pageMarker.error;
    }
    expect(
      pageMarker.value.events.flatMap((event) =>
        event.kind === "token" && event.token.kind === "full"
          ? [event.token.base?.identifier.value]
          : [],
      ),
    ).toEqual([canonical]);
    const placeholder = scan(`9319 U.S., ${text}`).result;
    if (Result.isError(placeholder)) {
      throw placeholder.error;
    }
    expect(
      placeholder.value.events.flatMap((event) =>
        event.kind === "token" && event.token.kind === "full"
          ? [event.token.base?.identifier.value]
          : [],
      ),
    ).toEqual([canonical]);
    const parallel = scan(`9319 U.S. 9527, ${text}`).result;
    if (Result.isError(parallel)) {
      throw parallel.error;
    }
    expect(
      parallel.value.events.flatMap((event) =>
        event.kind === "token" && event.token.kind === "full"
          ? [event.token.base?.identifier.value]
          : [],
      ),
    ).toEqual(["9319 U.S. 9527", canonical]);
    const short = scan(
      `9319 U.S. 9527, ${text.replace(FIRST_PAGE_RE, ", at 9891")}`,
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
    assertIdentity(`9137 ${spelling} 9246`);
    assertIdentity(`9137 ${spelling},9246`);
    assertIdentity(`9137 ${spelling}, 9246`);
  }
  assertProperty(
    "every unambiguous reporter spelling scans to its parsed identity",
    fc.property(
      fc.constantFrom(...spellings),
      fc.integer({ min: 9001, max: 9999 }),
      fc.integer({ min: 90_001, max: 99_999 }),
      fc.constantFrom(" ", "   ", "\r\n  ", "\u00a0\u00a0\u00a0"),
      fc.constantFrom("", ","),
      (spelling, volume, page, gap, separator) => {
        assertIdentity(
          `${String(volume)}${gap}${spelling}${separator}${gap}${String(page)}`,
        );
      },
    ),
  );
});

test("every exact table spelling proves a next-volume boundary", () => {
  const spellings = Object.keys(US_REPORTER_SPELLINGS);
  type ReporterBoundaryArgs = {
    spelling: string;
    volume: number;
    page: number;
  };
  const assertBoundary = ({ spelling, volume, page }: ReporterBoundaryArgs) => {
    const text = `${String(volume)} ${spelling} ${String(page)}`;
    const canonical = canonicalUsReporterCitation(text);
    const citations = [
      text,
      `${String(volume)} ${spelling},${String(page)}`,
      `${String(volume)} ${spelling} (987 U.S.) ${String(page)}`,
      `${String(volume)} ${spelling} (987 U.S.),${String(page)}`,
    ];
    for (const citation of citations) {
      for (const prefix of [
        "9319 U.S., ",
        "9319 U.S. 9527, ",
        "9319 U.S. 9527, 9528, ",
      ]) {
        const { result } = scan(prefix + citation);
        if (Result.isError(result)) {
          throw result.error;
        }
        expect(
          result.value.events.flatMap((event) =>
            event.kind === "token" && event.token.kind === "full"
              ? [event.token.base?.identifier.value ?? null]
              : [],
          ),
        ).toEqual(
          prefix === "9319 U.S., "
            ? [canonical]
            : ["9319 U.S. 9527", canonical],
        );
      }
    }
    for (const lead of [" at ", ", at "]) {
      const { result } = scan(
        `9319 U.S. 9527, ${String(volume)} ${spelling}${lead}${String(page)}`,
      );
      if (Result.isError(result)) {
        throw result.error;
      }
      expect(
        result.value.events.flatMap((event) =>
          event.kind === "token" && event.token.kind === "full"
            ? [event.token.pin]
            : [],
        ),
      ).toEqual([null]);
      expect(
        result.value.events.flatMap((event) =>
          event.kind === "token" ? [event.token.kind] : [],
        ),
      ).toEqual(["full", "volume-reporter"]);
    }
  };
  for (const spelling of spellings) {
    assertBoundary({ spelling, volume: 9137, page: 9246 });
  }
  assertProperty(
    "every exact table spelling proves a next-volume boundary",
    fc.property(
      fc.record({
        spelling: fc.constantFrom(...spellings),
        volume: fc.integer({ min: 9001, max: 9999 }),
        page: fc.integer({ min: 90_001, max: 99_999 }),
      }),
      assertBoundary,
    ),
  );
});

test(
  "reporter tokens retain their source spans under a prefix",
  () => {
    assertProperty(
      "reporter tokens retain their source spans under a prefix",
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
      { seed: propertySeed() },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "candidate production stops immediately past its work allowance",
  () => {
    assertProperty(
      "candidate production stops immediately past its work allowance",
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
      { seed: propertySeed() },
    );
  },
  propertyTestTimeout(10_000),
);

test(
  "long separator and digit runs stay bounded",
  () => {
    assertProperty(
      "long separator and digit runs stay bounded",
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
      { numRuns: 20, seed: propertySeed() },
    );
  },
  propertyTestTimeout(15_000),
);
