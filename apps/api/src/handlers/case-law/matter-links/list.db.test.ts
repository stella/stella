import { panic, Result } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawMatterLinks,
  caseLawSources,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import { listMatterLinksHandler } from "@/api/handlers/case-law/matter-links/list";
import { createSafeId } from "@/api/lib/branded-types";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import {
  PARTIAL_OBSERVATION_FIELD,
  PARTIAL_OBSERVATION_KEY,
} from "@/api/lib/legal-search/partial-observation-sql";
import { admitLawRead } from "@/api/lib/usage/law-read-admission";
import { OrganizationAccessReadError } from "@/api/lib/usage/public-law-access";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withPublicLawReaderRole } from "@/api/tests/pglite-test-db";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const workspaceId = createSafeId<"workspace">();
const emptyWorkspaceId = createSafeId<"workspace">();
const sourceId = createSafeId<"caseLawSource">();
const PUBLISHER_WORDING = "Admission permits this publisher headnote.";
const decisionFixtures = (
  [
    {
      name: "published",
      country: "CZE",
      metadata: { legalSentence: PUBLISHER_WORDING },
      expected: "read",
    },
    {
      name: "listing-only",
      country: "CZE",
      metadata: {
        legalSentence: PUBLISHER_WORDING,
        [PARTIAL_OBSERVATION_KEY]: {
          [PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY]: true,
        },
      },
      expected: "not_found",
    },
    {
      name: "unavailable-country",
      country: "DEU",
      metadata: { legalSentence: PUBLISHER_WORDING },
      expected: "not_found",
    },
  ] as const
).map((fixture, index) => ({
  ...fixture,
  decisionId: createSafeId<"caseLawDecision">(),
  linkId: createSafeId<"caseLawMatterLink">(),
  createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
}));

let db: TestDatabase;
let ids: TestIds;

beforeAll(
  async () => {
    const rlsFixture = await getRlsFixture();
    db = rlsFixture.testDb;
    ids = rlsFixture.ids;
    await db.insert(workspaces).values(
      [workspaceId, emptyWorkspaceId].map((id) => ({
        id,
        name: `Admission fixture ${id}`,
        reference: `ADMISSION-${id}`,
        organizationId: ids.orgA,
        clientId: ids.contactA,
      })),
    );
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: sourceId,
        adapterKey: "matter-links-admission",
      }),
    );
    await db.insert(caseLawDecisions).values(
      decisionFixtures.map((fixture) => ({
        id: fixture.decisionId,
        sourceId,
        caseNumber: fixture.name,
        court: "Admission court",
        country: fixture.country,
        language: "cs",
        fulltext: PUBLISHER_WORDING,
        metadata: fixture.metadata,
      })),
    );
    await db.insert(caseLawMatterLinks).values(
      decisionFixtures.map((fixture) => ({
        id: fixture.linkId,
        workspaceId,
        decisionId: fixture.decisionId,
        note: `Organization note ${fixture.name}`,
        linkedBy: ids.userA1,
        createdAt: fixture.createdAt,
      })),
    );
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await db
    .delete(caseLawMatterLinks)
    .where(eq(caseLawMatterLinks.workspaceId, workspaceId));
  await db.delete(caseLawDecisions).where(
    inArray(
      caseLawDecisions.id,
      decisionFixtures.map((fixture) => fixture.decisionId),
    ),
  );
  await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
  await db
    .delete(workspaces)
    .where(inArray(workspaces.id, [workspaceId, emptyWorkspaceId]));
  await releaseRlsFixture();
});

const ownedRecords = () =>
  decisionFixtures.toReversed().map((fixture) => ({
    id: fixture.linkId,
    decisionId: fixture.decisionId,
    note: `Organization note ${fixture.name}`,
    linkedBy: ids.userA1,
    createdAt: fixture.createdAt,
  }));

describe("matter law payload admission preserves organization links", () => {
  test.each([
    { type: "admitted", enabled: true },
    { type: "not_entitled", enabled: true },
    { type: "missing_scope", enabled: false },
    { type: "access_unavailable", enabled: true },
  ] as const)(
    "$type keeps notes, ownership, and link order",
    async (outcome) => {
      let corpusReads = 0;
      let accessReads = 0;
      const readCorpus = async <T>(
        read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
      ) => {
        corpusReads += 1;
        return await withPublicLawReaderRole(
          db,
          async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
        );
      };
      const response = await listMatterLinksHandler({
        workspaceId,
        organizationId: ids.orgA,
        scopedDb: asTestRaw(
          createScopedDb(db, [workspaceId], ids.orgA, ids.userA1),
        ),
        caseLawDb: Object.assign(readCorpus, caseLawPublicReadDb),
        admit: async (options) =>
          await admitLawRead({
            ...options,
            publicLawEnabled: () => outcome.enabled,
            mayReadPublicLaw: async () => {
              accessReads += 1;
              return outcome.type === "access_unavailable"
                ? Result.err(
                    new OrganizationAccessReadError({
                      message: "Access unavailable",
                      cause: null,
                    }),
                  )
                : Result.ok(outcome.type === "admitted");
            },
          }),
      });
      expect(response.links.map(({ decision, ...record }) => record)).toEqual(
        ownedRecords(),
      );
      expect(accessReads).toBe(outcome.enabled ? 1 : 0);
      if (outcome.type === "admitted") {
        expect(corpusReads).toBeGreaterThan(0);
        for (const fixture of decisionFixtures) {
          const link =
            response.links.find(
              (candidate) => candidate.id === fixture.linkId,
            ) ?? panic("Organization link missing");
          expect(link.decision.type).toBe(fixture.expected);
          if (fixture.expected === "read") {
            expect(link.decision).toMatchObject({
              type: "read",
              caseNumber: fixture.name,
              headnote: {
                type: "present",
                text: PUBLISHER_WORDING,
                truncated: false,
              },
            });
          } else {
            expect(link.decision).toEqual({ type: "not_found" });
          }
        }
        return;
      }
      expect(corpusReads).toBe(0);
      expect(response.links.map((link) => link.decision)).toEqual(
        decisionFixtures.map(() => ({ type: "refused", code: outcome.type })),
      );
      expect(JSON.stringify(response)).not.toContain(PUBLISHER_WORDING);
    },
  );

  test("an empty matter list does not request law admission", async () => {
    const response = await listMatterLinksHandler({
      workspaceId: emptyWorkspaceId,
      organizationId: ids.orgA,
      scopedDb: asTestRaw(
        createScopedDb(db, [emptyWorkspaceId], ids.orgA, ids.userA1),
      ),
      caseLawDb: Object.assign(
        async () => panic("An empty list cannot read public law"),
        caseLawPublicReadDb,
      ),
      admit: async () => panic("An empty list cannot require law admission"),
    });
    expect(response).toEqual({ links: [] });
  });
});
