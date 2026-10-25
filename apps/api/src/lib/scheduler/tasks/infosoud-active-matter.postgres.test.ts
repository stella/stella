import { describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { CaseSearchResultWithHearings } from "@stll/infosoud";

import { organization } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import {
  entities,
  entityVersions,
  infoSoudTrackedCases,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import { createSyncInfoSoudTrackedCasesTask } from "./infosoud";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const claimedAt = new Date("2026-10-23T12:00:00.000Z");

const lookup = {
  case: {
    cislo: 1,
    druh: "C",
    rocnik: 2026,
    bcVec: 1,
    nadrizenaOrganizace: null,
    organizace: "test-court",
    typOrganizace: "OS",
    stav: null,
    stavDatum: null,
    napad: null,
    udalosti: [
      {
        udalostId: 101,
        udalost: "test-event",
        poradi: 1,
        datum: "/Date(0)/",
        zruseno: false,
        znackaId: {
          cisloSenatu: 1,
          druhVeci: "C",
          bcVec: 1,
          rocnik: 2026,
          organizace: "test-court",
        },
        jednani: [],
      },
    ],
    navazneVeci: [],
    platneK: null,
  },
  hearings: {
    nadrizenaOrganizace: null,
    organizace: "test-court",
    jednaciSin: null,
    datum: null,
    typ: "SPZN",
    cislo: 1,
    bcVec: 1,
    druh: "C",
    rocnik: 2026,
    udalosti: [],
    platneK: null,
  },
} satisfies CaseSearchResultWithHearings;

const withTrackedCase = async (
  status: "active" | "archived",
  run: (fixture: {
    organizationId: ReturnType<typeof mintAuthProviderId<"organization">>;
    trackedCaseId: ReturnType<typeof createSafeId<"infoSoudTrackedCase">>;
    workspaceId: ReturnType<typeof createSafeId<"workspace">>;
  }) => Promise<void>,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const trackedCaseId = createSafeId<"infoSoudTrackedCase">();
  await rootDb.insert(organization).values({
    id: organizationId,
    name: "InfoSoud active-matter test",
    slug: `infosoud-active-${organizationId}`,
    createdAt: new Date(),
  });
  try {
    await rootDb.insert(workspaces).values({
      id: workspaceId,
      organizationId,
      name: "InfoSoud test matter",
      reference: workspaceId,
      status,
      lastActivityAt: new Date(0),
    });
    await rootDb.insert(infoSoudTrackedCases).values({
      id: trackedCaseId,
      workspaceId,
      courtCode: "test-court",
      spisZn: "1 C 1/2026",
      enabled: true,
    });
    await run({ organizationId, trackedCaseId, workspaceId });
  } finally {
    await rootDb
      .delete(organization)
      .where(eq(organization.id, organizationId));
  }
};

const taskContext = () =>
  asTestRaw<SchedulerTaskContext>({
    db: rootDb,
    dueAt: DueSlot.of({ nextRunAt: claimedAt, lockedAt: claimedAt }),
    logger: { info: mock(), warn: mock() },
    signal: new AbortController().signal,
  });

if (!databaseUrl || !runPostgres) {
  describe.skip("InfoSoud active-matter fence (postgres)", () => {
    test("requires DATABASE_URL and STELLA_RUN_POSTGRES_TESTS=true", () =>
      expect(true).toBe(true));
  });
} else {
  test("does not fetch a tracked case whose matter is already archived", async () => {
    await withTrackedCase(
      "archived",
      async ({ trackedCaseId, workspaceId }) => {
        const searchCaseWithHearings = mock(async () => lookup);
        const result = await createSyncInfoSoudTrackedCasesTask({
          searchCaseWithHearings,
        })(taskContext());

        expect(result.isOk()).toBe(true);
        expect(searchCaseWithHearings).not.toHaveBeenCalled();
        expect(
          await rootDb
            .select({ id: entities.id })
            .from(entities)
            .where(eq(entities.workspaceId, workspaceId)),
        ).toEqual([]);
        expect(
          await rootDb
            .select({
              lastSyncAttemptAt: infoSoudTrackedCases.lastSyncAttemptAt,
              lastSyncedAt: infoSoudTrackedCases.lastSyncedAt,
            })
            .from(infoSoudTrackedCases)
            .where(eq(infoSoudTrackedCases.id, trackedCaseId)),
        ).toEqual([{ lastSyncAttemptAt: null, lastSyncedAt: null }]);
      },
    );
  });

  test("refuses an import when the matter is archived during lookup", async () => {
    await withTrackedCase("active", async ({ trackedCaseId, workspaceId }) => {
      const result = await createSyncInfoSoudTrackedCasesTask({
        searchCaseWithHearings: async () => {
          await rootDb
            .update(workspaces)
            .set({ status: "archived" })
            .where(eq(workspaces.id, workspaceId));
          return lookup;
        },
      })(taskContext());

      expect(result.isErr()).toBe(true);
      expect(
        await rootDb
          .select({ id: entities.id })
          .from(entities)
          .where(eq(entities.workspaceId, workspaceId)),
      ).toEqual([]);
      expect(
        await rootDb
          .select({ id: entityVersions.id })
          .from(entityVersions)
          .where(eq(entityVersions.workspaceId, workspaceId)),
      ).toEqual([]);
      expect(
        await rootDb
          .select({
            lastSyncAttemptAt: infoSoudTrackedCases.lastSyncAttemptAt,
            lastSyncError: infoSoudTrackedCases.lastSyncError,
            lastSyncedAt: infoSoudTrackedCases.lastSyncedAt,
          })
          .from(infoSoudTrackedCases)
          .where(eq(infoSoudTrackedCases.id, trackedCaseId)),
      ).toEqual([
        {
          lastSyncAttemptAt: claimedAt,
          lastSyncError: "InfoSoudAgendaImportFailed",
          lastSyncedAt: null,
        },
      ]);
    });
  });
}
