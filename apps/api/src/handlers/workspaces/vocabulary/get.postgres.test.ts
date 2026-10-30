import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  contacts,
  infoSoudTrackedCases,
  workspaceContacts,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  matterVocabularyScalingScenario,
  seedMatterVocabulary,
} from "@/api/tests/read-scaling/matter-vocabulary";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

import { VOCABULARY_LIMITS } from "./candidates";
import { readVocabularyHandler } from "./get";

// Document visibility currently follows matter membership; documents in a
// matter outside that membership must contribute no titles to this sample.
describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "matter vocabulary with PostgreSQL RLS",
  () => {
    test("reads original matter and contact spelling, and only readable document titles", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const fixture = await seedMatterVocabulary({ db, size: 200 });
          try {
            const response = await readVocabularyHandler(fixture);
            if (!("candidates" in response)) {
              panic("Expected vocabulary candidates");
            }
            expect(response.candidates).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  term: "Zastoupení Ľuboše Říhy",
                  kind: "matter-name",
                }),
                expect.objectContaining({ term: "Ľuboš Říha", kind: "party" }),
                expect.objectContaining({ term: "Ľuboš Říha", kind: "person" }),
                expect.objectContaining({
                  term: "Žofia Šťastná",
                  kind: "person",
                }),
                expect.objectContaining({
                  term: "Čučoriedka, s. r. o.",
                  kind: "organization",
                }),
                expect.objectContaining({
                  term: "Čučoriedka, s. r. o.",
                  kind: "party",
                }),
                expect.objectContaining({
                  term: "ŘÍHA-2026",
                  kind: "case-number",
                }),
                expect.objectContaining({
                  term: "Nejvyšší soud",
                  kind: "court",
                }),
                expect.objectContaining({
                  term: "23 C 42/2026",
                  kind: "case-number",
                }),
              ]),
            );
            const titles = response.candidates.filter(
              ({ kind }) => kind === "document-title",
            );
            expect(titles).toHaveLength(VOCABULARY_LIMITS.perKind);
            expect(
              titles.every(({ term }) =>
                term.startsWith("Vyjádření Žofie Šťastné"),
              ),
            ).toBe(true);
            expect(
              titles.every(
                ({ lastUsedAt }) =>
                  lastUsedAt?.toISOString() === "2026-10-02T00:00:00.000Z",
              ),
            ).toBe(true);
            expect(
              response.candidates.some(({ term }) =>
                ["FOREIGN", "DENIED", "Složka", "Úkol"].includes(term),
              ),
            ).toBe(false);
            for (const workspaceId of [
              fixture.deniedWorkspaceId,
              fixture.foreignWorkspaceId,
              createSafeId<"workspace">(),
            ]) {
              expect(
                await readVocabularyHandler({ ...fixture, workspaceId }),
              ).toMatchObject({ code: 404 });
            }
            expect(
              await readVocabularyHandler({
                ...fixture,
                organizationId: fixture.otherOrganizationId,
              }),
            ).toMatchObject({ code: 404 });
          } finally {
            await fixture.cleanup();
          }
        },
      );
    });

    test("an empty personal matter contributes only its name and reference", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const fixture = await seedMatterVocabulary({ db, size: 0 });
          try {
            const workspaceId = createSafeId<"workspace">();
            await db.insert(workspaces).values({
              id: workspaceId,
              organizationId: fixture.organizationId,
              name: "Prázdná věc",
              reference: "PRÁZDNÁ",
            });
            // Keep membership as the sole read authority for this personal matter.
            await db.insert(workspaceMembers).values({
              id: createSafeId<"workspaceMember">(),
              workspaceId,
              userId: fixture.userId,
            });
            const response = await readVocabularyHandler({
              ...fixture,
              workspaceId,
            });
            if (!("candidates" in response)) {
              panic("Expected vocabulary candidates");
            }
            expect(
              response.candidates.map(({ term, kind }) => ({ term, kind })),
            ).toEqual([
              { term: "Prázdná věc", kind: "matter-name" },
              { term: "PRÁZDNÁ", kind: "case-number" },
            ]);
            await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
          } finally {
            await fixture.cleanup();
          }
        },
      );
    });

    test("caps linked contact and case candidates at their source and response boundaries", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const fixture = await seedMatterVocabulary({ db, size: 0 });
          try {
            const extraContacts = Array.from({ length: 90 }, (_, index) => ({
              id: createSafeId<"contact">(),
              organizationId: fixture.organizationId,
              type: "organization" as const,
              displayName: `Žďárská dílna ${String(index).padStart(3, "0")}`,
            }));
            await db.insert(contacts).values(extraContacts);
            await db.insert(workspaceContacts).values(
              extraContacts.map(({ id: contactId }, index) => ({
                id: createSafeId<"workspaceContact">(),
                contactId,
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                role: "opposing_party" as const,
                createdAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
              })),
            );
            await db.insert(infoSoudTrackedCases).values(
              Array.from({ length: 40 }, (_, index) => ({
                id: createSafeId<"infoSoudTrackedCase">(),
                workspaceId: fixture.workspaceId,
                courtCode: "KSJIMBR",
                spisZn: `24 C ${index}/2026`,
              })),
            );
            const response = await readVocabularyHandler(fixture);
            if (!("candidates" in response)) {
              panic("Expected vocabulary candidates");
            }
            expect(
              response.candidates.filter(({ kind }) => kind === "organization"),
            ).toHaveLength(VOCABULARY_LIMITS.perKind);
            expect(
              response.candidates.filter(({ kind }) => kind === "party"),
            ).toHaveLength(VOCABULARY_LIMITS.perKind);
            expect(
              response.candidates.filter(({ kind }) => kind === "case-number"),
            ).toHaveLength(VOCABULARY_LIMITS.perKind);
            expect(response.candidates.length).toBeLessThanOrEqual(
              VOCABULARY_LIMITS.total,
            );
            expect(
              response.candidates.some(
                ({ term }) => term === "Žďárská dílna 000",
              ),
            ).toBe(false);
          } finally {
            await fixture.cleanup();
          }
        },
      );
    });

    test("matter vocabulary statements and response size stay bounded at 10 and 200 historical documents", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const smallFixture = await seedMatterVocabulary({ db, size: 10 });
          try {
            const largeFixture = await seedMatterVocabulary({ db, size: 200 });
            try {
              const small =
                await matterVocabularyScalingScenario.measure(smallFixture);
              const large =
                await matterVocabularyScalingScenario.measure(largeFixture);
              console.info(
                "handler-scaling",
                JSON.stringify({
                  name: matterVocabularyScalingScenario.name,
                  at10: small,
                  at200: large,
                }),
              );
              expect(small.rows).toBe(41);
              expect(large.rows).toBe(small.rows);
              expect(small.statements).toBe(5);
              expect(small.transactionRoundTrips).toBe(2);
              expect(readScalingViolations({ small, large })).toEqual([]);
            } finally {
              await largeFixture.cleanup();
            }
          } finally {
            await smallFixture.cleanup();
          }
        },
      );
    });
  },
);
