/**
 * Revoking the requester's access stops an organisation export: the worker
 * reads through the requester's current membership and re-checks the export
 * permission when it claims the run and before every part.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { organizationDataExports } from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import { DATA_EXPORT_RECORD_BYTES_CAP } from "@/api/handlers/data-exports/build-export";
import type { ExportSource } from "@/api/handlers/data-exports/build-export";
import {
  DATA_EXPORT_FAILURE_MESSAGE,
  DATA_EXPORT_RUN_OUTCOME,
  runDataExport,
} from "@/api/handlers/data-exports/data-export-worker";
import { createExportSource } from "@/api/handlers/data-exports/export-source";
import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { createRootRunActor } from "@/api/lib/root-scoped-db";
import { brandPersistedDataExportId } from "@/api/lib/safe-id-boundaries";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

type ExportFixture = Awaited<ReturnType<typeof getRlsFixture>>;
let testDb: ExportFixture["testDb"];
let ids: ExportFixture["ids"];
let database: RlsDatabase<Transaction>;
const createdExportIds: SafeId<"dataExport">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  database = asTestRaw<RlsDatabase<Transaction>>(testDb);
});

afterAll(async () => {
  if (createdExportIds.length > 0) {
    await testDb
      .delete(organizationDataExports)
      .where(inArray(organizationDataExports.id, createdExportIds));
  }
  await releaseRlsFixture();
});

const setRole = async (role: "member" | "admin") => {
  await testDb
    .update(member)
    .set({ role })
    .where(eq(member.id, ids.memberA1org));
};

const queueExport = async () => {
  const id = toSafeId<"dataExport">(Bun.randomUUIDv7());
  createdExportIds.push(id);
  await testDb.insert(organizationDataExports).values({
    id,
    organizationId: ids.orgA,
    requestedBy: ids.userA1,
    versionScope: "all",
  });
  return id;
};

type RunOptions = {
  wrapSource?: (source: ExportSource) => ExportSource;
  beforePartClose?: () => Promise<void>;
  beforeManifestWrite?: () => Promise<void>;
};

const run = async (
  exportId: SafeId<"dataExport">,
  {
    wrapSource = (source) => source,
    beforePartClose = async () => {},
    beforeManifestWrite = async () => {},
  }: RunOptions = {},
) => {
  const actor = createRootRunActor(
    {
      organizationId: ids.orgA,
      workspaceId: null,
      userId: ids.userA1,
      runId: exportId,
    },
    brandPersistedDataExportId,
    database,
  );
  const signal = new AbortController().signal;
  const pace = async () => {};
  const parts: string[] = [];
  const outcome = await runDataExport(
    { exportId, organizationId: ids.orgA, userId: ids.userA1 },
    {
      db: actor.inputDb,
      source: wrapSource(
        createExportSource({
          db: actor.inputDb,
          organizationId: ids.orgA,
          signal,
          pace,
        }),
      ),
      storage: () => ({
        sink: {
          openPart: (fileName) => {
            parts.push(fileName);
            return { write: async () => {}, close: beforePartClose };
          },
        },
        writeManifest: beforeManifestWrite,
      }),
      pace,
      signal,
      partTargetBytes: 2 * 1024 ** 3,
      recordBytesCap: DATA_EXPORT_RECORD_BYTES_CAP,
      now: () => new Date("2026-10-14T10:00:00.000Z"),
    },
  );
  const [row] = await testDb
    .select({
      status: organizationDataExports.status,
      error: organizationDataExports.error,
    })
    .from(organizationDataExports)
    .where(eq(organizationDataExports.id, exportId));
  return { outcome, parts, row };
};

describe("organisation data export revocation", () => {
  test("a run stops when its requester no longer has access to the matter", async () => {
    // The requester is an admin when the run starts and is demoted while it
    // plans: they no longer reach the organisation's matters, so no part is
    // written.
    await setRole("admin");
    try {
      const exportId = await queueExport();
      const { outcome, parts, row } = await run(exportId, {
        wrapSource: (source) => ({
          ...source,
          listMatters: async (scope) => {
            await setRole("member");
            return await source.listMatters(scope);
          },
        }),
      });
      expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.FAILED);
      expect(parts).toEqual([]);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe(DATA_EXPORT_FAILURE_MESSAGE.notAuthorized);
    } finally {
      await setRole("member");
    }
  });

  test.each(["last-part", "manifest"] as const)(
    "revocation while committing the %s refuses publication",
    async (phase) => {
      await setRole("admin");
      try {
        const exportId = await queueExport();
        const revoke = async () => await setRole("member");
        const { outcome, parts, row } = await run(exportId, {
          ...(phase === "last-part"
            ? { beforePartClose: revoke }
            : { beforeManifestWrite: revoke }),
        });
        expect(parts).toHaveLength(1);
        expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.FAILED);
        expect(row?.status).toBe("failed");
        expect(row?.error).toBe(DATA_EXPORT_FAILURE_MESSAGE.notAuthorized);
      } finally {
        await setRole("member");
      }
    },
  );

  test("a run stops when its requester has left the organization", async () => {
    const [membership] = await testDb
      .select()
      .from(member)
      .where(eq(member.id, ids.memberA1org));
    if (membership === undefined) {
      throw new Error("fixture membership is missing");
    }
    await setRole("admin");
    const exportId = await queueExport();
    await testDb.delete(member).where(eq(member.id, ids.memberA1org));
    try {
      const { outcome, parts, row } = await run(exportId);
      expect(outcome).toBe(DATA_EXPORT_RUN_OUTCOME.FAILED);
      expect(parts).toEqual([]);
      expect(row?.status).toBe("failed");
      expect(row?.error).toBe(DATA_EXPORT_FAILURE_MESSAGE.notAuthorized);
    } finally {
      await testDb.insert(member).values({ ...membership, role: "member" });
    }
  });
});
