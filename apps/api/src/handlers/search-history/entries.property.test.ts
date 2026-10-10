import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";

import {
  canonicalSearchHistoryEntry,
  prepareSearchHistoryRows,
  toSearchHistoryEntryResponse,
} from "./entries";

const words = fc.array(
  fc.constantFrom("náhrada", "škody", "café", "řízení", "smlouva", "89/2012"),
  { minLength: 1, maxLength: 8 },
);
const owner = {
  organizationId: toSafeId<"organization">("history_property_organization"),
  userId: toSafeId<"user">("history_property_user"),
};

describe("search history normalization", () => {
  test("search-history normalization is a fixed point", () => {
    assertProperty(
      "search-history normalization is a fixed point",
      fc.property(fc.string({ maxLength: 500 }), (query) => {
        const canonical = canonicalSearchHistoryEntry({
          kind: "search",
          query,
        });
        if (canonical === null) {
          expect(query.trim()).toBe("");
          return;
        }
        expect(canonicalSearchHistoryEntry(canonical.entry)).toEqual(canonical);
      }),
    );
  });

  test("search-history equivalent spelling shares one match", () => {
    assertProperty(
      "search-history equivalent spelling shares one match",
      fc.property(
        words,
        fc.constantFrom(" ", "\t", "\n", "\u00a0", " \t "),
        (tokens, separator) => {
          const normal = tokens.join(" ");
          const variant = `\t${tokens.join(separator).toUpperCase().normalize("NFD")}\n`;
          expect(variant).not.toBe(normal);
          expect(
            canonicalSearchHistoryEntry({ kind: "search", query: variant })
              ?.match,
          ).toBe(
            canonicalSearchHistoryEntry({ kind: "search", query: normal })
              ?.match,
          );
        },
      ),
    );
  });

  test("search-history document identity survives encrypted batching and latest-use selection", async () => {
    const decisionIdentity = fc.oneof(
      fc.constant({ kind: "unknown" as const }),
      fc.record({
        kind: fc.constant("decision" as const),
        courtAbbreviation: fc.option(fc.constantFrom("NS", "NSS", "ÚS"), {
          nil: null,
        }),
        courtTier: fc.constantFrom(
          "supreme" as const,
          "constitutional" as const,
          "other" as const,
        ),
      }),
    );
    await assertProperty(
      "search-history document identity survives encrypted batching and latest-use selection",
      fc.asyncProperty(
        fc.array(decisionIdentity, { minLength: 1, maxLength: 12 }),
        async (identities) => {
          const uses = identities.map((documentIdentity, index) => ({
            entry: {
              kind: "decision" as const,
              documentId: "decision-identity",
              title: "23 Cdo 1001/2021",
              path: "/law/cze/cases/ns/23-cdo-1001-2021",
              documentIdentity,
            },
            usedAt: new Date(Date.UTC(2020, 0, 1) + index),
          }));
          const rows = await prepareSearchHistoryRows(owner, uses.toReversed());
          expect(rows).toHaveLength(1);
          const row = rows.at(0);
          if (!row) {
            panic("Expected prepared document history row");
          }
          const response = await toSearchHistoryEntryResponse(
            owner.organizationId,
            {
              ...row,
              id: toSafeId<"searchHistoryEntry">(
                "0191d14d-9a63-7d2e-a021-06053e542c85",
              ),
            },
          );
          expect(response).toMatchObject({
            kind: "decision",
            courtId: null,
            documentIdentity: identities.at(-1),
            useCount: identities.length,
          });
        },
      ),
      { numRuns: 50 },
    );
  });

  test("search-history statute identity preserves string citations and typed unknown values", async () => {
    const statuteIdentity = fc.oneof(
      fc.constant({ kind: "unknown" as const }),
      fc.record({
        kind: fc.constant("statute" as const),
        number: fc.option(fc.integer({ min: 1, max: 999_999 }).map(String), {
          nil: null,
        }),
        year: fc.option(fc.integer({ min: 1, max: 9999 }).map(String), {
          nil: null,
        }),
      }),
    );
    await assertProperty(
      "search-history statute identity preserves string citations and typed unknown values",
      fc.asyncProperty(statuteIdentity, async (documentIdentity) => {
        const rows = await prepareSearchHistoryRows(owner, [
          {
            entry: {
              kind: "statute",
              documentId: "/eli/cz/sb/2012/89",
              title: "Občanský zákoník",
              path: "/law/cze/statutes/89-2012",
              documentIdentity,
            },
            usedAt: new Date(Date.UTC(2020, 0, 1)),
          },
        ]);
        const row = rows.at(0);
        if (!row) {
          panic("Expected prepared statute history row");
        }
        const response = await toSearchHistoryEntryResponse(
          owner.organizationId,
          {
            ...row,
            id: toSafeId<"searchHistoryEntry">(
              "0191d14d-9a63-7d2e-a021-06053e542c85",
            ),
          },
        );
        expect(response).toMatchObject({ kind: "statute", documentIdentity });
        expect(Object.hasOwn(response, "statuteNumber")).toBe(false);
        expect(Object.hasOwn(response, "statuteYear")).toBe(false);
      }),
      { numRuns: 50 },
    );
  });

  test("search-history equivalent uses fold once with temporal bounds and latest spelling", async () => {
    await assertProperty(
      "search-history equivalent uses fold once with temporal bounds and latest spelling",
      fc.asyncProperty(
        words,
        fc.array(fc.integer({ min: 0, max: 10_000 }), {
          minLength: 1,
          maxLength: 12,
        }),
        async (tokens, times) => {
          const base = tokens.join(" ");
          const uses = times.map((time, index) => ({
            entry: {
              kind: "search" as const,
              query:
                index % 2 === 0 ? base.toUpperCase() : base.normalize("NFD"),
            },
            usedAt: new Date(Date.UTC(2020, 0, 1) + time),
          }));
          const rows = await prepareSearchHistoryRows(owner, uses);
          expect(rows).toHaveLength(1);
          const row = rows.at(0);
          if (!row) {
            throw new TypeError("Expected prepared history row");
          }
          expect(row.useCount).toBe(uses.length);
          expect(row.firstUsedAt.getTime()).toBe(
            Math.min(...uses.map(({ usedAt }) => usedAt.getTime())),
          );
          expect(row.lastUsedAt.getTime()).toBe(
            Math.max(...uses.map(({ usedAt }) => usedAt.getTime())),
          );
          let latest = uses.at(0);
          if (!latest) {
            panic("Expected at least one history use");
          }
          for (const use of uses) {
            if (use.usedAt >= latest.usedAt) {
              latest = use;
            }
          }
          const response = await toSearchHistoryEntryResponse(
            owner.organizationId,
            {
              ...row,
              id: toSafeId<"searchHistoryEntry">(
                "0191d14d-9a63-7d2e-a021-06053e542c85",
              ),
            },
          );
          expect(response).toMatchObject(
            canonicalSearchHistoryEntry(latest.entry)?.entry ?? {},
          );
        },
      ),
      { numRuns: 50 },
    );
  });
});
