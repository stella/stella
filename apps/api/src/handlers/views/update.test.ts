import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { fields, properties, workspaceViews } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import type { ViewLayout } from "@/api/lib/views-schema";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import updateView from "./update";

let fixture: Awaited<ReturnType<typeof getRlsFixture>>;
const viewId = createSafeId<"workspaceView">();

beforeAll(
  async () => {
    fixture = await getRlsFixture();
  },
  { timeout: 30_000 },
);

afterAll(releaseRlsFixture);

test("reordering and renaming a table view preserves its file column and documents", async () => {
  const { testDb, ids } = fixture;
  const layout = {
    type: "table",
    version: 1,
    columnOrder: [ids.filePropertyA1, ids.propertyA1],
    columnPinning: [ids.filePropertyA1],
    filters: [],
    sorts: [],
    hiddenProperties: [],
    calculations: [],
  } as const satisfies ViewLayout;
  await testDb.insert(workspaceViews).values({
    id: viewId,
    workspaceId: ids.wsA1,
    name: "Documents",
    layout,
    position: 0,
  });
  const beforeProperties = await testDb
    .select()
    .from(properties)
    .where(eq(properties.workspaceId, ids.wsA1));
  const beforeFields = await testDb
    .select()
    .from(fields)
    .where(eq(fields.propertyId, ids.filePropertyA1));
  expect(beforeFields.at(0)?.content.type).toBe("file");

  const nextLayout = {
    ...layout,
    columnOrder: [ids.propertyA1, ids.filePropertyA1],
  } as const satisfies ViewLayout;
  const result = await updateView.handler(
    asTestRaw<Parameters<typeof updateView.handler>[0]>({
      body: { name: "Evidence", layout: nextLayout },
      safeDb: createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1),
      memberRole: { role: "owner" },
      request: new Request("https://example.test/views/update"),
      route: "/v1/views/:workspaceId/:viewId",
      params: { viewId },
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      recordAuditEvent: async () => {},
    }),
  );

  expect(result).toEqual({});
  expect(
    await testDb.query.workspaceViews.findFirst({
      where: { id: { eq: viewId } },
    }),
  ).toMatchObject({ name: "Evidence", layout: nextLayout });
  expect(
    await testDb
      .select()
      .from(properties)
      .where(eq(properties.workspaceId, ids.wsA1)),
  ).toEqual(beforeProperties);
  expect(
    await testDb
      .select()
      .from(fields)
      .where(eq(fields.propertyId, ids.filePropertyA1)),
  ).toEqual(beforeFields);
});
