import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import {
  type CaseLawCanaryAnswer,
  caseLawSearchCanariesInvariant,
} from "./case-law-canary";
import {
  CASE_LAW_CANARY_LIMIT,
  caseLawCanariesEnvSchema,
  type CaseLawCanary,
} from "./config-schema";

const CONTEXT = {
  now: new Date("2026-10-17T09:00:00.000Z"),
  signal: new AbortController().signal,
};

const NO_HITS = {
  type: "hits",
  count: 0,
} as const satisfies CaseLawCanaryAnswer;

/** A search that answers each query from a fixed table, as a seeded index would. */
const searchAnswering =
  (answers: Readonly<Record<string, CaseLawCanaryAnswer>>) =>
  async ({ query }: CaseLawCanary) =>
    await Promise.resolve(answers[query] ?? NO_HITS);

describe("canary queries against case-law search", () => {
  test("an empty page, an unavailable index and a refused query each fire", async () => {
    const canaries = [
      { country: "CZ", query: "smlouva" },
      { country: "CZ", query: "nájemné" },
      { country: "PL", query: "umowa" },
      { country: "PL", query: "wyrok" },
      { country: "XX", query: "contract" },
    ];
    const verdict = await caseLawSearchCanariesInvariant({
      canaries,
      search: searchAnswering({
        smlouva: { type: "hits", count: 1 },
        nájemné: { type: "hits", count: 0 },
        umowa: { type: "index-unavailable" },
        wyrok: { type: "refused" },
        contract: { type: "unknown-country" },
      }),
    }).check(CONTEXT);

    expect(verdict).toEqual({
      status: "violated",
      checked: canaries.length,
      findings: [
        {
          target: "CZ#1",
          reason: "no-results",
          observed: 0,
          expected: ">= 1 hit",
        },
        {
          target: "PL#2",
          reason: "index-unavailable",
          observed: null,
          expected: "hits",
        },
        { target: "PL#3", reason: "refused", observed: null, expected: "hits" },
        {
          target: "XX#4",
          reason: "unknown-country",
          observed: null,
          expected: "hits",
        },
      ],
    });
  });

  test("findings never carry the canary's query text", async () => {
    const verdict = await caseLawSearchCanariesInvariant({
      canaries: [{ country: "CZ", query: "nájemné" }],
      search: searchAnswering({}),
    }).check(CONTEXT);
    expect(JSON.stringify(verdict)).not.toContain("nájemné");
  });

  test("answering canaries hold", async () => {
    expect(
      await caseLawSearchCanariesInvariant({
        canaries: [{ country: "CZ", query: "smlouva" }],
        search: searchAnswering({ smlouva: { type: "hits", count: 1 } }),
      }).check(CONTEXT),
    ).toEqual({ status: "held", checked: 1 });
  });

  test("no configured canary skips the invariant", async () => {
    expect(
      await caseLawSearchCanariesInvariant({
        canaries: [],
        search: searchAnswering({}),
      }).check(CONTEXT),
    ).toEqual({ status: "skipped", reason: "not-configured" });
  });
});

describe("the canary configuration", () => {
  test("normalizes the country and trims the query", () => {
    expect(
      v.parse(
        caseLawCanariesEnvSchema,
        JSON.stringify([{ country: "cz", query: " smlouva " }]),
      ),
    ).toEqual([{ country: "CZ", query: "smlouva" }]);
  });

  test("refuses more canaries than one run may search", () => {
    const canaries = Array.from({ length: CASE_LAW_CANARY_LIMIT + 1 }, () => ({
      country: "CZ",
      query: "smlouva",
    }));
    expect(
      v.safeParse(caseLawCanariesEnvSchema, JSON.stringify(canaries)).success,
    ).toBe(false);
  });

  test("refuses an empty query", () => {
    expect(
      v.safeParse(
        caseLawCanariesEnvSchema,
        JSON.stringify([{ country: "CZ", query: "  " }]),
      ).success,
    ).toBe(false);
  });
});
