import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { databaseRelations } from "@/api/db/database-relations";
import type { SafeDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  buildActiveDecisionSection,
  buildActiveStatuteSection,
} from "@/api/handlers/chat/chat-prompt";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import type { CorpusSourceDescriptor } from "@/api/lib/legal-search/corpus-source";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { readStoredVersionAst } from "@/api/lib/legal-search/legislation-version-blocks";
import { legislationPublicReadDb } from "@/api/lib/legislation-public-read-db";
import type {
  LegislationPublicReadDb,
  LegislationReadTransaction,
} from "@/api/lib/legislation-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const POLICIES = [
  { name: "legacy", descriptor: null, expected: "available" },
  {
    name: "open",
    descriptor: {
      license: "public-domain",
      attribution: null,
      allowsRedistribution: true,
      allowsDerivedAi: true,
    },
    expected: "available",
  },
  {
    name: "no-ai",
    descriptor: {
      license: "restricted",
      attribution: null,
      allowsRedistribution: true,
      allowsDerivedAi: false,
    },
    expected: "withheld",
  },
  {
    name: "private",
    descriptor: {
      license: "restricted",
      attribution: null,
      allowsRedistribution: false,
      allowsDerivedAi: true,
    },
    expected: "absent",
  },
] as const satisfies readonly {
  name: string;
  descriptor: CorpusSourceDescriptor | null;
  expected: string;
}[];
const COUNTRIES = ["CZE", "SVK", "POL", "DEU"] as const;
const fixtures = COUNTRIES.flatMap((country) =>
  POLICIES.map((policy) => ({
    name: `${policy.name}-${country}`,
    country,
    descriptor: policy.descriptor,
    expected: country === "CZE" ? policy.expected : ("absent" as const),
    decisionId: createSafeId<"caseLawDecision">(),
    caseSourceId: createSafeId<"caseLawSource">(),
    statuteId: createSafeId<"legislationDocument">(),
    statuteSourceId: createSafeId<"legislationSource">(),
  })),
);
const listingId = createSafeId<"caseLawDecision">();
const unavailableCountryId = createSafeId<"caseLawDecision">();
const WORDING = "Distinct corpus wording must obey the source permission.";
const tenantDb: SafeDb = () =>
  panic("Anonymous corpus prompts must not read tenant data");
let client: Awaited<ReturnType<typeof createTestPglite>>;
let caseLawDb: CaseLawPublicReadDb;
let legislationDb: LegislationPublicReadDb;
let revokeStatuteAi: () => Promise<void>;
beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client, relations: databaseRelations });
    const readCases = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (tx) =>
          await fn({
            query: tx.query,
            select: tx.select.bind(tx),
            execute: () => panic("This corpus prompt does not execute raw SQL"),
          }),
      );
    caseLawDb = Object.assign(readCases, caseLawPublicReadDb);
    const readStatutes = async <T>(
      fn: (tx: LegislationReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(
        db,
        async (tx) =>
          await fn({
            select: tx.select.bind(tx),
            execute: () => panic("This corpus prompt does not execute raw SQL"),
          }),
      );
    legislationDb = Object.assign(readStatutes, legislationPublicReadDb);
    for (const fixture of fixtures) {
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: fixture.caseSourceId,
          adapterKey: fixture.name,
          descriptor: fixture.descriptor,
        }),
      );
      await db.insert(caseLawDecisions).values({
        id: fixture.decisionId,
        sourceId: fixture.caseSourceId,
        caseNumber: fixture.name,
        country: fixture.country,
        court: "Court",
        language: "cs",
        fulltext: WORDING,
      });
      await db.insert(legislationSources).values({
        id: fixture.statuteSourceId,
        adapterKey: fixture.name,
        name: fixture.name,
        descriptor: fixture.descriptor,
      });
      await db.insert(legislationDocuments).values({
        id: fixture.statuteId,
        sourceId: fixture.statuteSourceId,
        eli: `test/${fixture.name}`,
        title: fixture.name,
        country: fixture.country,
        language: "cs",
        fulltext: WORDING,
        status: "current",
        documentAst: EMPTY_AST,
      });
    }
    const open =
      fixtures.find((fixture) => fixture.name === "open-CZE") ??
      panic("Open fixture missing");
    revokeStatuteAi = async () => {
      await db
        .update(legislationSources)
        .set({
          descriptor: {
            license: "restricted",
            attribution: null,
            allowsRedistribution: true,
            allowsDerivedAi: false,
          },
        })
        .where(eq(legislationSources.id, open.statuteSourceId));
    };
    await db.insert(caseLawDecisions).values([
      {
        id: listingId,
        sourceId: open.caseSourceId,
        caseNumber: "unpublished listing",
        country: "CZE",
        court: "Court",
        language: "cs",
        fulltext: WORDING,
        metadata: { _stellaPartialObservation: { isListingOnly: true } },
      },
      {
        id: unavailableCountryId,
        sourceId: open.caseSourceId,
        caseNumber: "unpublished country",
        country: "XAA",
        court: "Court",
        language: "xx",
        fulltext: WORDING,
      },
    ]);
  },
  { timeout: 120_000 },
);
afterAll(async () => await client.close());
test.each(fixtures)(
  "active corpus prompts enforce $name source policy",
  async (fixture) => {
    const organizationId =
      fixture.expected === "available"
        ? undefined
        : toSafeId<"organization">("org-corpus-policy");
    const userId =
      fixture.expected === "available"
        ? undefined
        : toSafeId<"user">("user-corpus-policy");
    const decision = await buildActiveDecisionSection({
      activeDecision: { decisionId: fixture.decisionId },
      caseLawDb,
      organizationId,
      safeDb: tenantDb,
      userId,
    });
    const statute = await buildActiveStatuteSection({
      activeStatute: { documentId: fixture.statuteId },
      legislationDb,
      organizationId,
      safeDb: tenantDb,
      userId,
    });
    const fallbackAst = await readStoredVersionAst({
      legislationDb,
      id: fixture.statuteId,
      purpose: "derived-ai",
    });
    expect(fallbackAst).toEqual(
      fixture.expected === "available" ? EMPTY_AST : null,
    );
    const expected = fixture.expected;
    for (const prompt of [decision.unwrap(), statute.unwrap()]) {
      switch (expected) {
        case "available":
          expect(prompt).toContain(WORDING);
          expect(prompt).not.toContain("does not permit derived AI");
          break;
        case "withheld":
          expect(prompt).toContain(fixture.name);
          expect(prompt).toContain("does not permit derived AI");
          expect(prompt).not.toContain(WORDING);
          break;
        case "absent":
          expect(prompt).toBe("");
          break;
        default:
          expected satisfies never;
          panic("Unhandled source policy fixture");
      }
    }
  },
);
test("client-provided active decision ids cannot disclose unpublished or missing decisions", async () => {
  for (const decisionId of [
    listingId,
    unavailableCountryId,
    createSafeId<"caseLawDecision">(),
  ]) {
    const prompt = await buildActiveDecisionSection({
      activeDecision: { decisionId },
      caseLawDb,
      organizationId: undefined,
      safeDb: tenantDb,
      userId: undefined,
    });
    expect(prompt.unwrap()).toBe("");
  }
});

test("statute fallback withholds wording and marks when AI permission changes between reads", async () => {
  const open =
    fixtures.find((fixture) => fixture.name === "open-CZE") ??
    panic("Open fixture missing");
  let reads = 0;
  const revokeBeforeFallback = async <T>(
    fn: (tx: LegislationReadTransaction) => Promise<T>,
  ) => {
    reads += 1;
    if (reads === 2) {
      await revokeStatuteAi();
    }
    return await legislationDb(fn);
  };
  const changingReader = Object.assign(
    revokeBeforeFallback,
    legislationPublicReadDb,
  );
  const result = await buildActiveStatuteSection({
    activeStatute: { documentId: open.statuteId },
    legislationDb: changingReader,
    organizationId: toSafeId<"organization">("org-corpus-policy"),
    userId: toSafeId<"user">("user-corpus-policy"),
    safeDb: tenantDb,
  });
  expect(reads).toBe(2);
  expect(result.unwrap()).toContain("does not permit derived AI");
  expect(result.unwrap()).not.toContain(WORDING);
});
