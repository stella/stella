import { describe, expect, test } from "bun:test";

import {
  CONFLICT_CHECK_OUTCOMES,
  CONFLICT_SEVERITIES,
} from "@stll/api-contract/conflict-checks";
import type {
  ConflictCheckOutcome,
  ConflictCoverageGap,
  ConflictSeverity,
} from "@stll/api-contract/conflict-checks";

import { toSafeId } from "@/api/lib/branded-types";

import { conflictCheckOutcome } from "./outcome";
import type {
  StoredConflictHit,
  StoredConflictPartyResult,
} from "./stored-results";

const hit = (severities: readonly ConflictSeverity[]): StoredConflictHit => ({
  contactId: toSafeId<"contact">("00000000-0000-4000-8000-000000000001"),
  contactName: "Acme Holding s.r.o.",
  contactType: "organization",
  tier: "exact_name",
  score: 1,
  matchedName: "Acme Holding s.r.o.",
  evidence: {
    nameScore: 1,
    identifier: "not-compared",
    birthDate: "not-compared",
    entityType: "match",
  },
  links: severities.map((severity, index) => ({
    access: "walled",
    workspaceId: toSafeId<"workspace">(
      `00000000-0000-4000-8000-00000000010${String(index)}`,
    ),
    severity,
  })),
});

const party = (
  hits: StoredConflictHit[],
  flags: { truncated?: boolean; incomplete?: boolean } = {},
): StoredConflictPartyResult => ({
  hits,
  totalMatches: hits.length,
  truncated: flags.truncated ?? false,
  incomplete: flags.incomplete ?? false,
});

const rank = (outcome: ConflictCheckOutcome) =>
  CONFLICT_CHECK_OUTCOMES.indexOf(outcome);

describe("conflict check outcome", () => {
  test("a potential conflict outranks everything", () => {
    expect(
      conflictCheckOutcome({
        gaps: ["contacts_over_cap"],
        parties: [party([hit(["needs_review", "potential_conflict"])])],
      }),
    ).toBe("potential_conflict");
  });

  test("an address book over the cap is incomplete, never no matches", () => {
    expect(
      conflictCheckOutcome({
        gaps: ["contacts_over_cap"],
        parties: [party([])],
      }),
    ).toBe("incomplete");
    expect(
      conflictCheckOutcome({
        gaps: ["contacts_over_cap"],
        parties: [party([hit(["needs_review"])])],
      }),
    ).toBe("incomplete");
  });

  test("a party left unscreened is incomplete, never no matches", () => {
    expect(
      conflictCheckOutcome({
        gaps: [],
        parties: [party([]), party([], { incomplete: true })],
      }),
    ).toBe("incomplete");
  });

  test("a truncated party needs review even with only informational hits", () => {
    expect(
      conflictCheckOutcome({
        gaps: [],
        parties: [party([hit(["information"])], { truncated: true })],
      }),
    ).toBe("needs_review");
  });

  test("informational hits are not no matches", () => {
    expect(
      conflictCheckOutcome({ gaps: [], parties: [party([hit([])])] }),
    ).toBe("information_only");
    expect(conflictCheckOutcome({ gaps: [], parties: [party([])] })).toBe(
      "no_matches",
    );
  });

  test("no matches only when nothing matched and everything was searched; adding a hit or a gap never lowers the outcome", () => {
    const gapChoices: ConflictCoverageGap[][] = [[], ["contacts_over_cap"]];
    const severityChoices: ConflictSeverity[][] = [
      [],
      ...CONFLICT_SEVERITIES.map((severity) => [severity]),
    ];
    for (const gaps of gapChoices) {
      for (const severities of severityChoices) {
        for (const incomplete of [false, true]) {
          for (const truncated of [false, true]) {
            const hits = severities.length === 0 ? [] : [hit(severities)];
            const base = conflictCheckOutcome({
              gaps,
              parties: [party(hits, { incomplete, truncated })],
            });
            if (base === "no_matches") {
              expect(gaps).toEqual([]);
              expect(hits).toEqual([]);
              expect(incomplete || truncated).toBe(false);
            }
            for (const severity of CONFLICT_SEVERITIES) {
              const withHit = conflictCheckOutcome({
                gaps,
                parties: [
                  party([...hits, hit([severity])], { incomplete, truncated }),
                ],
              });
              expect(rank(withHit)).toBeLessThanOrEqual(rank(base));
            }
            const withGap = conflictCheckOutcome({
              gaps: ["contacts_over_cap"],
              parties: [party(hits, { incomplete, truncated })],
            });
            expect(rank(withGap)).toBeLessThanOrEqual(rank(base));
            expect(withGap).not.toBe("no_matches");
          }
        }
      }
    }
  });
});
