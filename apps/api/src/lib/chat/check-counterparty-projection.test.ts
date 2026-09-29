import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { CZ_INSOLVENCY_SOURCE } from "@stll/business-registries/entity-checks";

import type { CounterpartyCheckResult } from "@/api/lib/business-registries/entity-checks";
import { CHECK_COUNTERPARTY_PROJECTION } from "@/api/lib/chat/projections";
import { unavailableSanctionsScreening } from "@/api/lib/lists/sanctions/screening-service";
import { SANCTIONS_UNAVAILABLE_REASONS } from "@/api/lib/lists/sanctions/screening-vocabulary";

// check_counterparty forwards the shared check's result verbatim, so its
// projection must accept both result families and nothing else.

const NOW = new Date("2026-09-29T08:00:00.000Z");

const registerClear = {
  status: "clear",
  kind: "cz-insolvency",
  source: CZ_INSOLVENCY_SOURCE,
  subject: { type: "company-id", value: "26863154" },
  checkedAt: "2026-09-29T08:00:00Z",
  sourceDataAsOf: null,
  record: null,
} as const satisfies CounterpartyCheckResult;

const sanctionsPossibleMatch = {
  kind: "sanctions",
  status: "possible-match",
  subject: {
    type: "organization",
    name: "Acme Trading",
    identifiers: ["26863154"],
    resolvedFrom: {
      type: "company-id",
      value: "26863154",
      country: "CZ",
      registry: "ares",
    },
  },
  checkedAt: NOW.toISOString(),
  cutoff: 0.8,
  lists: [
    {
      source: "un",
      issuer: "UN",
      issuerName: "United Nations",
      classification: "binding",
      status: "possible-match",
      reason: null,
      checkedAt: NOW.toISOString(),
      editionId: "0b8f7c1e-3a52-4c1b-9d0e-4f6a2b7c8d90",
      publishedAt: "2026-09-28",
      verifiedAt: "2026-09-29T06:00:00.000Z",
      totalMatches: 12,
      truncated: true,
      possibleMatches: [
        {
          sourceEntryId: "6908555",
          editionId: "0b8f7c1e-3a52-4c1b-9d0e-4f6a2b7c8d90",
          score: 0.93,
          sourceUrl: "https://lists.example/un/6908555",
          name: "ACME TRADING COMPANY",
          referenceNumber: "QDe.001",
          entityType: "organisation",
          programme: null,
          listedOn: null,
          evidence: {
            nameScore: 0.93,
            matchedName: "ACME TRADING COMPANY",
            birthDate: "not-compared",
            nationality: "not-compared",
            entityType: "match",
            identifier: "not-compared",
            conflicts: [],
          },
        },
      ],
    },
  ],
} satisfies CounterpartyCheckResult;

describe("check_counterparty projection", () => {
  test("accepts a register outcome and a sanctions outcome", () => {
    expect(
      v.safeParse(CHECK_COUNTERPARTY_PROJECTION, registerClear).success,
    ).toBe(true);
    expect(
      v.safeParse(CHECK_COUNTERPARTY_PROJECTION, sanctionsPossibleMatch)
        .success,
    ).toBe(true);
  });

  test.each(SANCTIONS_UNAVAILABLE_REASONS)(
    "accepts every list unavailable for %s, with no edition",
    (reason) => {
      const screening = {
        kind: "sanctions",
        subject: { type: "company-id", value: "26863154", country: "CZ" },
        ...unavailableSanctionsScreening({
          reason,
          practiceJurisdictions: ["CZ"],
          now: NOW,
        }),
      } satisfies CounterpartyCheckResult;
      expect(screening.status).toBe("unavailable");
      expect(
        v.safeParse(CHECK_COUNTERPARTY_PROJECTION, screening).success,
      ).toBe(true);
    },
  );

  test("refuses a sanctions list carrying a field the contract does not name", () => {
    const [list] = sanctionsPossibleMatch.lists;
    const withExtra = {
      ...sanctionsPossibleMatch,
      lists: [{ ...list, rawEntry: {} }],
    };
    expect(v.safeParse(CHECK_COUNTERPARTY_PROJECTION, withExtra).success).toBe(
      false,
    );
  });

  test("refuses a register outcome dressed with sanctions fields", () => {
    const mixed = { ...registerClear, lists: [] };
    expect(v.safeParse(CHECK_COUNTERPARTY_PROJECTION, mixed).success).toBe(
      false,
    );
  });
});
