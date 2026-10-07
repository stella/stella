import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";

import type { PermissionInput } from "@stll/permissions";

import { properties, workspaceViews } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import createView from "@/api/handlers/views/create";
import updateView from "@/api/handlers/views/update";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { AuthorizedMemberRole } from "@/api/lib/permission-authorization";
import type { ViewLayout, ViewTemplateProperty } from "@/api/lib/views-schema";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

/**
 * A view's template can create the columns it needs. Creating a column spends
 * `property:create`, so a credential narrowed to view permissions reuses
 * existing columns but creates none, whatever its owner's role allows.
 */

let testDb: TestDatabase;
let ids: TestIds;
const createdViewIds: SafeId<"workspaceView">[] = [];
const columnNames: string[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (createdViewIds.length > 0) {
      await testDb
        .delete(workspaceViews)
        .where(inArray(workspaceViews.id, createdViewIds));
    }
    if (columnNames.length > 0) {
      await testDb
        .delete(properties)
        .where(
          and(
            eq(properties.workspaceId, ids.wsA1),
            inArray(properties.name, columnNames),
          ),
        );
    }
  } finally {
    await releaseRlsFixture();
  }
});

const ownerKey = (permissions: PermissionInput): AuthorizedMemberRole =>
  authorizedMemberRole({
    role: "owner",
    credential: { type: "attenuated", permissions },
  });

const VIEW_ONLY = { view: ["create", "update"] } satisfies PermissionInput;
const VIEW_AND_COLUMNS = {
  view: ["create", "update"],
  property: ["create"],
} satisfies PermissionInput;

const templateColumn = (name: string): ViewTemplateProperty => ({
  version: 1,
  sourceId: `source_${name}`,
  name,
  content: { version: 1, type: "text" },
  tool: { version: 1, type: "manual-input" },
  role: null,
  createIfMissing: true,
});

const tableLayout = (column: ViewTemplateProperty): ViewLayout => ({
  version: 1,
  type: "table",
  columnOrder: [column.sourceId],
  columnPinning: [],
  hiddenProperties: [],
  calculations: [],
  filters: [],
  sorts: [],
});

const ownerSafeDb = () =>
  createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userAdmin);

const createViewAs = async (
  memberRole: AuthorizedMemberRole,
  column: ViewTemplateProperty,
) => {
  const viewId = toSafeId<"workspaceView">(Bun.randomUUIDv7());
  createdViewIds.push(viewId);
  const result = await createView.handler(
    createTestHandlerContext<Parameters<typeof createView.handler>[0]>({
      recordAuditEvent: auditRecorderDouble(),
      createAuditRecorder: () => auditRecorderDouble(),
      memberRole,
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      safeDb: ownerSafeDb(),
      scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userAdmin),
      body: {
        id: viewId,
        name: `Credential view ${viewId}`,
        layout: tableLayout(column),
        templateProperties: [column],
      },
    }),
  );
  return { viewId, result };
};

const columnCount = async (name: string) =>
  await testDb.$count(
    properties,
    and(eq(properties.workspaceId, ids.wsA1), eq(properties.name, name)),
  );
const viewCount = async (viewId: SafeId<"workspaceView">) =>
  await testDb.$count(workspaceViews, eq(workspaceViews.id, viewId));

const freshColumn = () => {
  const name = `Credential column ${Bun.randomUUIDv7()}`;
  columnNames.push(name);
  return templateColumn(name);
};

describe("template columns on a view", () => {
  test("a credential without property:create creates no column and no view", async () => {
    const column = freshColumn();

    const { viewId, result } = await createViewAs(ownerKey(VIEW_ONLY), column);

    expect(result).toMatchObject({ code: 403 });
    expect(await columnCount(column.name)).toBe(0);
    expect(await viewCount(viewId)).toBe(0);
  });

  test("the same credential with property:create creates both", async () => {
    const column = freshColumn();

    const { viewId } = await createViewAs(ownerKey(VIEW_AND_COLUMNS), column);

    expect(await columnCount(column.name)).toBe(1);
    expect(await viewCount(viewId)).toBe(1);
  });

  test("a person's session keeps creating columns its role allows", async () => {
    const column = freshColumn();

    const { viewId } = await createViewAs(sessionMemberRole("owner"), column);

    expect(await columnCount(column.name)).toBe(1);
    expect(await viewCount(viewId)).toBe(1);
  });

  test("a credential without property:create still reuses an existing column", async () => {
    const column = freshColumn();
    await createViewAs(ownerKey(VIEW_AND_COLUMNS), column);

    const { viewId } = await createViewAs(ownerKey(VIEW_ONLY), column);

    expect(await columnCount(column.name)).toBe(1);
    expect(await viewCount(viewId)).toBe(1);
  });

  test("updating a view's template spends property:create the same way", async () => {
    const { viewId } = await createViewAs(
      ownerKey(VIEW_AND_COLUMNS),
      freshColumn(),
    );
    const column = freshColumn();

    const update = async (memberRole: AuthorizedMemberRole) =>
      await updateView.handler(
        createTestHandlerContext<Parameters<typeof updateView.handler>[0]>({
          recordAuditEvent: auditRecorderDouble(),
          createAuditRecorder: () => auditRecorderDouble(),
          memberRole,
          workspaceId: ids.wsA1,
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userAdmin },
          safeDb: ownerSafeDb(),
          scopedDb: createScopedDb(testDb, [ids.wsA1], ids.orgA, ids.userAdmin),
          params: { workspaceId: ids.wsA1, viewId },
          body: { layout: tableLayout(column), templateProperties: [column] },
        }),
      );

    expect(await update(ownerKey(VIEW_ONLY))).toMatchObject({ code: 403 });
    expect(await columnCount(column.name)).toBe(0);

    await update(ownerKey(VIEW_AND_COLUMNS));
    expect(await columnCount(column.name)).toBe(1);
  });
});
