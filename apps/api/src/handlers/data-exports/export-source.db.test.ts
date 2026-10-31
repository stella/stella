import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  entities,
  entityVersions,
  templateVersions,
  workspaces,
} from "@/api/db/schema";
import type { RlsDatabase } from "@/api/db/scoped";
import type { SourceVersionSelection } from "@/api/handlers/data-exports/build-export";
import { createExportSource } from "@/api/handlers/data-exports/export-source";
import { createSafeId } from "@/api/lib/branded-types";
import { createRootMembershipScopedDb } from "@/api/lib/root-scoped-db";
import { seedDataExportCompleteness } from "@/api/tests/helpers/data-export-completeness";
import type { DataExportCompletenessFixture } from "@/api/tests/helpers/data-export-completeness";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

let fixture: DataExportCompletenessFixture | undefined;

beforeAll(async () => {
  fixture = await seedDataExportCompleteness(await getTestDb());
});

afterAll(async () => {
  if (fixture !== undefined) {
    await fixture.cleanup();
  }
  await releaseTestDb();
});

describe("planned data export source versions", () => {
  test("keeps the planned version after promotion and omits it after tombstoning", async () => {
    const activeFixture =
      fixture ?? panic("The export source fixture is missing");
    const matterRows = await activeFixture.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.organizationId, activeFixture.organizationId),
          isNotNull(workspaces.clientId),
        ),
      )
      .orderBy(asc(workspaces.id))
      .limit(1);
    const matter = matterRows.at(0) ?? panic("The fixture matter is missing");
    const documentRows = await activeFixture.db
      .select({ id: entities.id, currentVersionId: entities.currentVersionId })
      .from(entities)
      .where(
        and(
          eq(entities.workspaceId, matter.id),
          inArray(entities.kind, ["document", "message"]),
        ),
      )
      .orderBy(asc(entities.id))
      .limit(1);
    const document =
      documentRows.at(0) ?? panic("The fixture document is missing");
    const versions = await activeFixture.db
      .select({ id: entityVersions.id })
      .from(entityVersions)
      .where(
        and(
          eq(entityVersions.workspaceId, matter.id),
          eq(entityVersions.entityId, document.id),
          isNull(entityVersions.deletedAt),
        ),
      )
      .orderBy(asc(entityVersions.versionNumber));
    const selectedVersion =
      versions.at(0) ?? panic("The fixture version is missing");
    const promotedVersionId = createSafeId<"entityVersion">();
    await activeFixture.db.insert(entityVersions).values({
      id: promotedVersionId,
      workspaceId: matter.id,
      entityId: document.id,
      versionNumber: 2,
      createdBy: activeFixture.userId,
    });
    const selection = {
      type: "planned",
      documents: {
        [document.id]: {
          currentVersionId: selectedVersion.id,
          versions: { [selectedVersion.id]: { files: {} } },
        },
      },
    } satisfies SourceVersionSelection;
    const source = createExportSource({
      db: createRootMembershipScopedDb(
        {
          organizationId: activeFixture.organizationId,
          userId: activeFixture.userId,
        },
        asTestRaw<RlsDatabase<Transaction>>(activeFixture.db),
      ),
      organizationId: activeFixture.organizationId,
      signal: new AbortController().signal,
      pace: async () => {},
    });

    try {
      await activeFixture.db
        .update(entities)
        .set({ currentVersionId: promotedVersionId })
        .where(eq(entities.id, document.id));
      const promoted = await source.loadMatter(matter.id, selection);
      const promotedDocument = promoted?.documents.find(
        (candidate) => candidate.id === document.id,
      );
      expect(promotedDocument?.currentVersionId).toBe(selectedVersion.id);
      expect(promotedDocument?.versions.map((version) => version.id)).toEqual([
        selectedVersion.id,
      ]);

      await activeFixture.db
        .update(entityVersions)
        .set({ deletedAt: new Date("2026-10-29T00:00:00.000Z") })
        .where(eq(entityVersions.id, selectedVersion.id));
      const deleted = await source.loadMatter(matter.id, selection);
      const deletedDocument = deleted?.documents.find(
        (candidate) => candidate.id === document.id,
      );
      expect(deletedDocument?.versions).toEqual([]);
    } finally {
      await activeFixture.db
        .update(entityVersions)
        .set({ deletedAt: null })
        .where(eq(entityVersions.id, selectedVersion.id));
      await activeFixture.db
        .update(entities)
        .set({ currentVersionId: document.currentVersionId })
        .where(eq(entities.id, document.id));
    }
  });

  test("refreshes planned template identities after a version disappears", async () => {
    const activeFixture =
      fixture ?? panic("The export source fixture is missing");
    const source = createExportSource({
      db: createRootMembershipScopedDb(
        {
          organizationId: activeFixture.organizationId,
          userId: activeFixture.userId,
        },
        asTestRaw<RlsDatabase<Transaction>>(activeFixture.db),
      ),
      organizationId: activeFixture.organizationId,
      signal: new AbortController().signal,
      pace: async () => {},
    });
    const before = await source.loadOrganizationRecords();
    const rows = await activeFixture.db
      .select()
      .from(templateVersions)
      .where(eq(templateVersions.organizationId, activeFixture.organizationId))
      .limit(1);
    const version =
      rows.at(0) ?? panic("The planned template version fixture is missing");
    expect(
      before.templateFiles.map((file) => file.templateVersionId),
    ).toContain(version.id);
    await activeFixture.db
      .delete(templateVersions)
      .where(eq(templateVersions.id, version.id));
    try {
      const refreshed = await source.loadOrganizationRecords();
      expect(
        refreshed.templateFiles.map((file) => file.templateVersionId),
      ).not.toContain(version.id);
      expect(
        await source.readFile({
          type: "template",
          templateVersionId: version.id,
        }),
      ).toEqual({ type: "missing" });
    } finally {
      await activeFixture.db.insert(templateVersions).values(version);
    }
  });
});
