import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import "@/api/tests/setup-env";

import { DESKTOP_RUNNER_APPROVAL_MODES } from "@stll/api-contract/desktop-runner";

import type { SafeDb } from "@/api/db/safe-db";
import { auditLogs, organizationSettings } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import readOrganizationSettings from "@/api/handlers/organization-settings/get";
import updateLocalRunApprovalCeiling from "@/api/handlers/organization-settings/local-runs/update";
import {
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { readLocalRunApprovalCeiling } from "@/api/lib/chat/local-run-approval-ceiling";
import {
  hasMemberPermission,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

const safeDbFor = (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [], organizationId, userId));

// timeout: booting the full PGlite schema can exceed the default hook budget.
beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
}, 60_000);

afterAll(releaseTestDb);

const save = async (maxApprovals: string) => {
  const body = v.parse(updateLocalRunApprovalCeiling.config.body, {
    maxApprovals,
  });
  return await updateLocalRunApprovalCeiling.handler(
    createTestHandlerContext<
      Parameters<typeof updateLocalRunApprovalCeiling.handler>[0]
    >({
      audit: createBackgroundAuditRecorder({
        organizationId: ids.orgA,
        userId: ids.userA1,
        workspaceId: null,
        execution: {
          performer: { type: "user", id: ids.userA1 },
          trigger: { type: "system", source: "local_run_ceiling_test" },
        },
      }),
      scopedDb: NO_DB,
      safeDb: safeDbFor(ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      body,
    }),
  );
};

const readGeneralSettings = async () =>
  await readOrganizationSettings.handler(
    createTestHandlerContext<
      Parameters<typeof readOrganizationSettings.handler>[0]
    >({
      audit: NO_AUDIT,
      scopedDb: NO_DB,
      safeDb: safeDbFor(ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
    }),
  );

const ceilingAudits = async () =>
  await testDb
    .select({ changes: auditLogs.changes })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, ids.orgA),
        eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS),
      ),
    );

describe("the organization's ceiling on local run approvals", () => {
  test("only an administrator may set it, and only to one of the three modes", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(
        hasMemberPermission(
          sessionMemberRole(role),
          updateLocalRunApprovalCeiling.config.permissions,
        ),
      ).toBe(true);
    }
    for (const role of ["member", "intern", "external"] as const) {
      expect(
        hasMemberPermission(
          sessionMemberRole(role),
          updateLocalRunApprovalCeiling.config.permissions,
        ),
      ).toBe(false);
    }
    for (const mode of DESKTOP_RUNNER_APPROVAL_MODES) {
      expect(
        v.is(updateLocalRunApprovalCeiling.config.body, { maxApprovals: mode }),
      ).toBe(true);
    }
    for (const maxApprovals of ["bypass", "", null]) {
      expect(
        v.is(updateLocalRunApprovalCeiling.config.body, { maxApprovals }),
      ).toBe(false);
    }
  });

  test("allows every mode until an administrator lowers it, then reads back the saved mode with its audit", async () => {
    await testDb
      .delete(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA));
    const before = (
      await readLocalRunApprovalCeiling(
        safeDbFor(ids.orgA, ids.userA1),
        ids.orgA,
      )
    ).unwrap();
    expect(before).toBe("full_auto");
    expect(await readGeneralSettings()).toMatchObject({
      localRunMaxApprovalMode: "full_auto",
    });

    expect(await save("auto")).toEqual({ maxApprovals: "auto" });
    const stored = await testDb
      .select({ ceiling: organizationSettings.localRunMaxApprovalMode })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA));
    expect(stored).toEqual([{ ceiling: "auto" }]);
    expect(
      (
        await readLocalRunApprovalCeiling(
          safeDbFor(ids.orgA, ids.userA1),
          ids.orgA,
        )
      ).unwrap(),
    ).toBe("auto");
    expect(await readGeneralSettings()).toMatchObject({
      localRunMaxApprovalMode: "auto",
    });
    expect(await ceilingAudits()).toEqual([
      {
        changes: { localRunMaxApprovalMode: { old: "full_auto", new: "auto" } },
      },
    ]);

    // The other organization keeps its own ceiling.
    expect(
      (
        await readLocalRunApprovalCeiling(
          safeDbFor(ids.orgB, ids.userB1),
          ids.orgB,
        )
      ).unwrap(),
    ).toBe("full_auto");

    // Saving the mode already in force changes and audits nothing.
    expect(await save("auto")).toEqual({ maxApprovals: "auto" });
    expect(await ceilingAudits()).toHaveLength(1);

    expect(await save("ask")).toEqual({ maxApprovals: "ask" });
    expect((await ceilingAudits()).at(-1)).toEqual({
      changes: { localRunMaxApprovalMode: { old: "auto", new: "ask" } },
    });
  });

  test("the database refuses a mode outside the three", async () => {
    const refused = await testDb
      .update(organizationSettings)
      .set({
        localRunMaxApprovalMode: asTestRaw<"ask">("bypass"),
      })
      .where(eq(organizationSettings.organizationId, ids.orgA))
      .then(
        () => "stored",
        () => "refused",
      );
    expect(refused).toBe("refused");
  });
});
