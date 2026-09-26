/**
 * The resolver's doctrine stated twice, once as SQL over batches and once as
 * a function of one reference's holders, must give one answer.
 *
 * Every case below writes a citing decision and the holders of one key, then
 * asks three questions of the same reference: the pre-write classification,
 * the per-decision walk over a stored pending row, and
 * `resolveDecisionReference` over the holders as the lookup reads them. The
 * outcome, the rule and the target must agree across all three, and so must
 * the walk's cross-border count.
 *
 * The holders are read by `readReferenceHolders`, unfiltered; jurisdiction,
 * time, self, language grouping, the cap and every rule are left to the
 * function.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_DECISION_TYPE_HINT } from "@/api/handlers/case-law/citation-decision-type-hint";
import {
  classifyCitationsBeforeWrite,
  resolveCitationsForDecision,
} from "@/api/handlers/case-law/citation-resolution";
import {
  CITATION_CANDIDATE_SCAN_CAP,
  CITATION_RESOLUTION_RULES,
  CITATION_RESOLUTION_STATUS,
} from "@/api/handlers/case-law/citation-resolution-status";
import type { DecisionReference } from "@/api/handlers/case-law/citations/decision-references";
import { resolveDecisionReference } from "@/api/handlers/case-law/citations/reference-resolution";
import type { ReferenceResolution } from "@/api/handlers/case-law/citations/reference-resolution";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readReferenceHolders } from "@/api/tests/helpers/citation-reference-holders";
import type { StoredReference } from "@/api/tests/helpers/citation-reference-holders";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();

type HolderSpec = {
  /** Referenced by `expect.target`. */
  name?: string;
  country?: string;
  court?: string;
  decisionDate?: string | null;
  decisionType?: string | null;
  language?: string;
  group?: string;
  ecli?: string;
  /** Held under the legacy key bridge unless typed identifiers are given. */
  identifiers?: { type: DecisionIdentifierType; normalizedValue: string }[];
  /** Overrides the case key on the holder's own `citation_key`. */
  citationKey?: string | null;
};

type ReferenceSpec = {
  citationKey?: string | null;
  identifierType?: DecisionIdentifierType | null;
  normalizedValue?: string | null;
  hints?: Partial<DecisionReference["hints"]>;
};

type Expected =
  | {
      status: typeof CITATION_RESOLUTION_STATUS.RESOLVED;
      rule: (typeof CITATION_RESOLUTION_RULES)[number];
      target: string;
    }
  | { status: typeof CITATION_RESOLUTION_STATUS.AMBIGUOUS }
  | {
      status: typeof CITATION_RESOLUTION_STATUS.UNMATCHED;
      blocked: boolean;
    }
  | { status: typeof CITATION_RESOLUTION_STATUS.PENDING };

type Case = {
  name: string;
  citing?: {
    country?: string;
    decisionDate?: string | null;
    language?: string;
    /** The citing decision holds the case key itself. */
    holdsKey?: boolean;
  };
  reference?: ReferenceSpec;
  holders: HolderSpec[];
  expect: Expected;
};

const NS = "Nejvyšší soud";
const US = "Ústavní soud";
const [nalez, usneseni] = ["nález", "usnesení"];

const cases: Case[] = [
  {
    name: "one holder",
    holders: [{ name: "only" }],
    expect: { status: "resolved", rule: "unique-key", target: "only" },
  },
  {
    name: "no holder",
    holders: [],
    expect: { status: "unmatched", blocked: false },
  },
  {
    name: "a holder across a border the citing jurisdiction does not reach",
    holders: [{ country: "SVK", court: "Najvyšší súd" }],
    expect: { status: "unmatched", blocked: true },
  },
  {
    name: "a holder published after the citing decision",
    holders: [{ decisionDate: "2022-01-01" }],
    expect: { status: "unmatched", blocked: false },
  },
  {
    name: "a later holder across a border is not a blocked one",
    holders: [{ country: "SVK", decisionDate: "2022-01-01" }],
    expect: { status: "unmatched", blocked: false },
  },
  {
    name: "the citing decision itself",
    citing: { holdsKey: true },
    holders: [],
    expect: { status: "unmatched", blocked: false },
  },
  {
    name: "a supranational holder the member state reaches",
    holders: [{ name: "eu", country: "EU", court: "Soudní dvůr" }],
    expect: { status: "resolved", rule: "unique-key", target: "eu" },
  },
  {
    name: "a national holder the supranational court does not reach",
    citing: { country: "EU", language: "en" },
    holders: [{}],
    expect: { status: "unmatched", blocked: true },
  },
  {
    name: "a citing jurisdiction with no declared reach",
    citing: { country: "XXX" },
    holders: [{}],
    expect: { status: "pending" },
  },
  {
    name: "a printed form that does not canonicalize",
    reference: {
      citationKey: null,
      identifierType: null,
      normalizedValue: null,
    },
    holders: [{}],
    expect: { status: "pending" },
  },
  {
    name: "a holder with no date passes the time filter",
    holders: [{ name: "undated", decisionDate: null }],
    expect: { status: "resolved", rule: "unique-key", target: "undated" },
  },
  {
    name: "two holders and nothing to tell them apart",
    holders: [{}, {}],
    expect: { status: "ambiguous" },
  },
  {
    name: "two manifestations of one judgment, citing language first",
    citing: { language: "sk" },
    holders: [
      { group: "one-judgment", language: "cs" },
      { name: "slovak", group: "one-judgment", language: "sk" },
    ],
    expect: { status: "resolved", rule: "unique-key", target: "slovak" },
  },
  {
    name: "two manifestations, neither in the citing language",
    citing: { language: "de" },
    holders: [
      { name: "czech", group: "one-judgment", language: "cs" },
      { group: "one-judgment", language: "sk" },
    ],
    expect: { status: "resolved", rule: "unique-key", target: "czech" },
  },
  {
    name: "a typed identifier, not the key",
    reference: {
      identifierType: DECISION_IDENTIFIER_TYPES.ECLI,
      normalizedValue: "ECLI:EU:C:2020:123",
    },
    holders: [
      {
        name: "ecli",
        country: "EU",
        citationKey: null,
        identifiers: [{ type: "ecli", normalizedValue: "ECLI:EU:C:2020:123" }],
      },
      // Holds the key under the legacy bridge, which a typed reference skips.
      {},
    ],
    expect: { status: "resolved", rule: "unique-key", target: "ecli" },
  },
  {
    name: "a key held as a case-number identifier and under the bridge",
    holders: [
      {
        name: "typed",
        identifiers: [{ type: "case-number", normalizedValue: "$key" }],
      },
    ],
    expect: { status: "resolved", rule: "unique-key", target: "typed" },
  },
  {
    name: "the printed sheet on one holder's ECLI",
    reference: { hints: { sheetNumber: "33" } },
    holders: [
      { name: "sheet", ecli: "ECLI:CZ:NSS:2021:8.As.287.2020.33" },
      { ecli: "ECLI:CZ:NSS:2021:8.As.287.2020.45" },
    ],
    expect: { status: "resolved", rule: "sheet-number", target: "sheet" },
  },
  {
    name: "the printed sheet on one holder's case-number identifier",
    reference: { hints: { sheetNumber: "12" } },
    holders: [
      {
        name: "sheet",
        identifiers: [
          { type: "case-number", normalizedValue: "8as/1/2020-12" },
        ],
      },
      {},
    ],
    expect: { status: "resolved", rule: "sheet-number", target: "sheet" },
  },
  {
    name: "the printed sheet on two holders",
    reference: {
      hints: {
        sheetNumber: "33",
        decisionType: CITATION_DECISION_TYPE_HINT.MERITS,
      },
    },
    holders: [
      { ecli: "ECLI:CZ:US:2021:1.US.1.21.33", decisionType: nalez, court: US },
      {
        ecli: "ECLI:CZ:US:2020:1.US.1.21.33",
        decisionType: usneseni,
        court: US,
      },
    ],
    expect: { status: "ambiguous" },
  },
  {
    name: "the printed date on one holder",
    reference: { hints: { decisionDate: "2019-03-03" } },
    holders: [
      { name: "dated", decisionDate: "2019-03-03" },
      { decisionDate: "2019-05-05" },
    ],
    expect: { status: "resolved", rule: "decision-date", target: "dated" },
  },
  {
    name: "the sheet outranks the date",
    reference: { hints: { sheetNumber: "7", decisionDate: "2019-05-05" } },
    holders: [
      {
        name: "sheet",
        decisionDate: "2019-03-03",
        ecli: "ECLI:CZ:NS:2019:1.CDO.1.2019.7",
      },
      { decisionDate: "2019-05-05", ecli: "ECLI:CZ:NS:2019:1.CDO.1.2019.9" },
    ],
    expect: { status: "resolved", rule: "sheet-number", target: "sheet" },
  },
  {
    name: "the printed date on two holders withholds the one-file rule",
    reference: { hints: { decisionDate: "2019-03-03" } },
    holders: [
      { court: US, decisionType: nalez, decisionDate: "2019-03-03" },
      { court: US, decisionType: usneseni, decisionDate: "2019-03-03" },
    ],
    expect: { status: "ambiguous" },
  },
  {
    name: "the printed type on one holder",
    reference: { hints: { decisionType: CITATION_DECISION_TYPE_HINT.ORDER } },
    holders: [
      { court: US, decisionType: nalez },
      { name: "order", court: US, decisionType: usneseni },
    ],
    expect: { status: "resolved", rule: "type-hint", target: "order" },
  },
  {
    name: "the printed type through another language's spelling",
    citing: { country: "HUN", language: "hu" },
    reference: { hints: { decisionType: CITATION_DECISION_TYPE_HINT.ORDER } },
    holders: [
      {
        country: "HUN",
        court: "Kúria",
        decisionType: "ítélet",
        language: "hu",
      },
      {
        name: "vegzes",
        country: "HUN",
        court: "Kúria",
        decisionType: "végzés",
        language: "hu",
      },
    ],
    expect: { status: "resolved", rule: "type-hint", target: "vegzes" },
  },
  {
    name: "the printed type on a capitalised stored type",
    reference: {
      hints: { decisionType: CITATION_DECISION_TYPE_HINT.JUDGMENT },
    },
    holders: [
      { name: "judgment", decisionType: "Rozsudek" },
      { decisionType: usneseni },
    ],
    expect: { status: "resolved", rule: "type-hint", target: "judgment" },
  },
  {
    name: "the printed type on two holders withholds the one-file rule",
    reference: { hints: { decisionType: CITATION_DECISION_TYPE_HINT.ORDER } },
    holders: [
      { court: US, decisionType: nalez },
      { court: US, decisionType: usneseni },
      { court: US, decisionType: usneseni },
    ],
    expect: { status: "ambiguous" },
  },
  {
    name: "the printed court on one holder",
    reference: {
      hints: {
        court: "Krajského soudu v Brně",
        decisionType: CITATION_DECISION_TYPE_HINT.JUDGMENT,
      },
    },
    holders: [
      { name: "brno", court: "Krajský soud v Brně" },
      { court: "Krajský soud v Ostravě" },
    ],
    expect: { status: "resolved", rule: "court-hint", target: "brno" },
  },
  {
    name: "a type hint that singles out a holder outranks the court",
    reference: {
      hints: {
        court: "Krajského soudu v Brně",
        decisionType: CITATION_DECISION_TYPE_HINT.ORDER,
      },
    },
    holders: [
      { court: "Krajský soud v Brně", decisionType: "rozsudek" },
      {
        name: "order",
        court: "Krajský soud v Ostravě",
        decisionType: usneseni,
      },
    ],
    expect: { status: "resolved", rule: "type-hint", target: "order" },
  },
  {
    name: "one file, one merits decision",
    holders: [
      { name: "merits", court: US, decisionType: nalez },
      { court: US, decisionType: usneseni },
      { court: US, decisionType: "uznesenie" },
    ],
    expect: { status: "resolved", rule: "one-file-merits", target: "merits" },
  },
  {
    name: "one merits decision across two courts",
    holders: [
      { court: US, decisionType: nalez },
      { court: NS, decisionType: usneseni },
    ],
    expect: { status: "ambiguous" },
  },
  {
    name: "one merits decision beside an untyped holder",
    holders: [
      { court: US, decisionType: nalez },
      { court: US, decisionType: null },
    ],
    expect: { status: "ambiguous" },
  },
  {
    name: "a file one short of the cap",
    holders: [
      { name: "merits", court: US, decisionType: nalez },
      ...Array.from({ length: CITATION_CANDIDATE_SCAN_CAP - 2 }, () => ({
        court: US,
        decisionType: usneseni,
      })),
    ],
    expect: { status: "resolved", rule: "one-file-merits", target: "merits" },
  },
  {
    name: "a file at the cap",
    holders: [
      { court: US, decisionType: nalez },
      ...Array.from({ length: CITATION_CANDIDATE_SCAN_CAP - 1 }, () => ({
        court: US,
        decisionType: usneseni,
      })),
    ],
    expect: { status: "ambiguous" },
  },
  {
    name: "a file past the cap, with a date only one holder carries",
    reference: { hints: { decisionDate: "2018-08-08" } },
    holders: [
      { decisionDate: "2018-08-08" },
      ...Array.from({ length: CITATION_CANDIDATE_SCAN_CAP }, () => ({})),
    ],
    expect: { status: "ambiguous" },
  },
];

type Outcome = {
  status: string;
  target: string | null;
  rule: string | null;
};

const PENDING: Outcome = {
  status: CITATION_RESOLUTION_STATUS.PENDING,
  target: null,
  rule: null,
};

/** One case written out: the decisions' ids by name, and the reference. */
type Written = {
  citingId: SafeId<"caseLawDecision">;
  names: Map<string, string>;
  reference: StoredReference;
};

const writeCase = async (
  { citing = {}, reference = {}, holders }: Case,
  index: number,
): Promise<Written> => {
  const key = `k${String(index)}/2020`;
  const citingId = createSafeId<"caseLawDecision">();
  const names = new Map<string, string>();
  await db.insert(caseLawDecisions).values({
    id: citingId,
    sourceId,
    sourceDocumentId: citingId,
    slug: citingId,
    caseNumber: `citing ${String(index)}`,
    citationKey: citing.holdsKey === true ? key : `citing/${String(index)}`,
    court: NS,
    country: citing.country ?? "CZE",
    language: citing.language ?? "cs",
    decisionDate:
      citing.decisionDate === undefined ? "2021-01-01" : citing.decisionDate,
    languageGroupKey: citingId,
    fulltext: "text",
  });
  for (const holder of holders) {
    const id = createSafeId<"caseLawDecision">();
    if (holder.name !== undefined) {
      names.set(id, holder.name);
    }
    await db.insert(caseLawDecisions).values({
      id,
      sourceId,
      sourceDocumentId: id,
      slug: id,
      caseNumber: key,
      citationKey: holder.citationKey === undefined ? key : holder.citationKey,
      court: holder.court ?? NS,
      country: holder.country ?? "CZE",
      language: holder.language ?? "cs",
      decisionDate:
        holder.decisionDate === undefined ? "2019-01-01" : holder.decisionDate,
      decisionType:
        holder.decisionType === undefined ? "rozsudek" : holder.decisionType,
      ecli: holder.ecli ?? null,
      languageGroupKey: holder.group ?? id,
      fulltext: "text",
    });
    if (holder.identifiers !== undefined) {
      await db.insert(caseLawDecisionIdentifiers).values(
        holder.identifiers.map((identifier) => {
          const normalizedValue = identifier.normalizedValue.replace(
            "$key",
            () => key,
          );
          return {
            decisionId: id,
            type: identifier.type,
            value: normalizedValue,
            normalizedValue,
          };
        }),
      );
    }
  }
  return {
    citingId,
    names,
    reference: {
      citationKey:
        reference.citationKey === undefined ? key : reference.citationKey,
      identifierType:
        reference.identifierType === undefined
          ? DECISION_IDENTIFIER_TYPES.CASE_NUMBER
          : reference.identifierType,
      normalizedValue:
        reference.normalizedValue === undefined
          ? key
          : reference.normalizedValue,
      hints: {
        court: null,
        decisionType: null,
        sheetNumber: null,
        decisionDate: null,
        ...reference.hints,
      },
    },
  };
};

const readCiting = async (citingId: SafeId<"caseLawDecision">) => {
  const [row] = await db
    .select({
      country: caseLawDecisions.country,
      decisionDate: caseLawDecisions.decisionDate,
      language: caseLawDecisions.language,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, citingId));
  if (row === undefined) {
    throw new TypeError("expected the citing decision");
  }
  return row;
};

const outcomeOf = (resolution: ReferenceResolution | null): Outcome => {
  if (resolution === null) {
    return PENDING;
  }
  return resolution.status === CITATION_RESOLUTION_STATUS.RESOLVED
    ? {
        status: resolution.status,
        target: resolution.decisionId,
        rule: resolution.rule,
      }
    : { status: resolution.status, target: null, rule: null };
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "reference-resolution-parity",
    name: "reference resolution parity",
  });
}, 120_000);

afterAll(async () => {
  await client.close();
});

const expectOneOutcome = async (
  testCase: Case,
  index: number,
): Promise<void> => {
  const { citingId, names, reference } = await writeCase(testCase, index);
  const unwritten = {
    id: createSafeId<"caseLawCitation">(),
    citationKey: reference.citationKey,
    identifierType: reference.identifierType,
    normalizedIdentifierValue: reference.normalizedValue,
    citedDecisionTypeHint: reference.hints.decisionType,
    citedCourtHint: reference.hints.court,
    citedSheetNumber: reference.hints.sheetNumber,
    citedDecisionDate: reference.hints.decisionDate,
  };

  const classified = (
    await classifyCitationsBeforeWrite(db, {
      citingDecisionId: citingId,
      citations: [unwritten],
    })
  ).get(unwritten.id);

  await db.insert(caseLawCitations).values({
    ...unwritten,
    citingDecisionId: citingId,
    citationText: reference.citationKey ?? "unkeyed",
  });
  const counts = await resolveCitationsForDecision(db, citingId);
  const [walked] = await db
    .select({
      status: caseLawCitations.resolutionStatus,
      target: caseLawCitations.citedDecisionId,
      rule: caseLawCitations.resolutionRuleId,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, unwritten.id));

  const citing = await readCiting(citingId);
  const stated = resolveDecisionReference({
    citing: {
      decisionId: citingId,
      jurisdiction: citing.country,
      decisionDate: citing.decisionDate,
      language: citing.language,
    },
    reference,
    holders: await readReferenceHolders(db, reference),
  });

  const fromHolders = outcomeOf(stated);
  expect(
    classified === undefined
      ? PENDING
      : {
          status: classified.resolutionStatus,
          target: classified.citedDecisionId,
          rule: classified.resolutionRuleId,
        },
  ).toEqual(fromHolders);
  expect(walked).toEqual(fromHolders);
  expect(counts.jurisdictionBlocked).toBe(
    stated?.status === CITATION_RESOLUTION_STATUS.UNMATCHED &&
      stated.jurisdictionBlocked
      ? 1
      : 0,
  );

  // The declared outcome, so agreement on a wrong answer still fails.
  const expected = testCase.expect;
  expect(fromHolders.status).toBe(expected.status);
  if (expected.status === CITATION_RESOLUTION_STATUS.RESOLVED) {
    expect(fromHolders.rule).toBe(expected.rule);
    expect(names.get(fromHolders.target ?? "")).toBe(expected.target);
  }
  if (expected.status === CITATION_RESOLUTION_STATUS.UNMATCHED) {
    expect(counts.jurisdictionBlocked).toBe(expected.blocked ? 1 : 0);
  }
};

for (const [index, testCase] of cases.entries()) {
  test(`one outcome from SQL and from holders: ${testCase.name}`, async () => {
    await expectOneOutcome(testCase, index);
  });
}

test("the matrix declares every rule and every outcome", () => {
  // Each case above asserts its declared outcome, so what is declared here is
  // what the matrix exercises.
  const declared = new Set(
    cases.map(({ expect: expected }) => {
      switch (expected.status) {
        case CITATION_RESOLUTION_STATUS.RESOLVED:
          return expected.rule;
        case CITATION_RESOLUTION_STATUS.UNMATCHED:
          return expected.blocked ? "unmatched, blocked" : "unmatched";
        default:
          return expected.status;
      }
    }),
  );
  expect([...declared].toSorted()).toEqual(
    [
      ...CITATION_RESOLUTION_RULES,
      CITATION_RESOLUTION_STATUS.AMBIGUOUS,
      CITATION_RESOLUTION_STATUS.PENDING,
      "unmatched",
      "unmatched, blocked",
    ].toSorted(),
  );
});
