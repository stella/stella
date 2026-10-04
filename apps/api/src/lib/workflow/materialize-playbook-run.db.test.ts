import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { FILE_PROPERTY_TYPE_IMMUTABLE_CODE } from "@stll/api-contract/property-policy";

import { auditLogs, playbookDefinitions, properties } from "@/api/db/schema";
import type { PropertyContent } from "@/api/db/schema-validators";
import { createSafeDb } from "@/api/db/scoped";
import { createBackgroundAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { materializePlaybookRun } from "./materialize-playbook-run";
import type { Position } from "./playbook-positions";

const ids = createTestIds();
let db: TestDatabase;
beforeAll(async () => {
  db = await getTestDb();
  await setupRlsTestData(db, ids);
  await db
    .update(properties)
    .set({ system: true })
    .where(eq(properties.id, ids.filePropertyA1));
}, 300_000);
afterAll(releaseTestDb);

test.each([
  [
    { version: 1, type: "file" },
    { version: 1, type: "text" },
  ],
  [
    { version: 1, type: "text" },
    { version: 1, type: "file" },
  ],
] satisfies [PropertyContent, PropertyContent][])(
  "materialization preserves an existing $type classification",
  async (initial, incoming) => {
    const playbookId = createSafeId<"playbookDefinition">();
    const sourceId = Bun.randomUUIDv7();
    await db.insert(playbookDefinitions).values({
      id: playbookId,
      organizationId: ids.orgA,
      name: "Materialized column policy",
      positions: { version: 3, items: [] },
    });
    const recordAuditEvent = createBackgroundAuditRecorder({
      organizationId: ids.orgA,
      workspaceId: ids.wsA1,
      userId: ids.userA1,
      execution: {
        performer: { type: "user", id: ids.userA1 },
        trigger: { type: "direct" },
      },
    });
    const countAuditEvents = async () =>
      await db.$count(auditLogs, eq(auditLogs.resourceId, playbookId));
    type RunOptions = {
      content: PropertyContent;
      issue: string;
      prependNewPosition?: boolean;
    };
    const run = async ({
      content,
      issue,
      prependNewPosition = false,
    }: RunOptions) => {
      const positions = [
        {
          mode: "extract",
          sourceId,
          issue,
          enabled: true,
          ask: { question: "", content },
        },
      ] satisfies Position[];
      if (prependNewPosition) {
        positions.unshift({
          mode: "extract",
          sourceId: Bun.randomUUIDv7(),
          issue: "Additional column",
          enabled: true,
          ask: { question: "", content: { version: 1, type: "text" } },
        });
      }
      return await createSafeDb(
        db,
        [ids.wsA1],
        ids.orgA,
        ids.userA1,
      )(
        async (tx) =>
          await materializePlaybookRun({
            tx,
            workspaceId: ids.wsA1,
            organizationId: ids.orgA,
            playbookId,
            positions,
            scope: null,
            recordAuditEvent,
          }),
      );
    };
    const created = await run({ content: initial, issue: "Initial column" });
    expect(created.isOk()).toBe(true);
    if (created.isErr() || !created.value.ok) {
      panic("Initial materialization was refused");
    }
    const propertyId = created.value.materializedPropertyIds.at(0);
    if (!propertyId) {
      panic("Materialization did not produce a column");
    }
    const before = await db.query.properties.findFirst({
      where: { id: { eq: propertyId } },
    });
    const propertyCount = await db.$count(
      properties,
      eq(properties.workspaceId, ids.wsA1),
    );
    const refusal = await run({
      content: incoming,
      issue: "Changed column",
      prependNewPosition: true,
    });
    expect(refusal.isOk()).toBe(true);
    if (refusal.isErr()) {
      panic("Materialization failed without its typed refusal");
    }
    expect(refusal.value).toMatchObject({
      ok: false,
      status: 422,
      code: FILE_PROPERTY_TYPE_IMMUTABLE_CODE,
      retryable: false,
      hint: expect.any(String),
    });
    expect(
      await db.query.properties.findFirst({
        where: { id: { eq: propertyId } },
      }),
    ).toEqual(before);
    expect(
      await db.$count(properties, eq(properties.workspaceId, ids.wsA1)),
    ).toBe(propertyCount);
    expect(await countAuditEvents()).toBe(1);
    const rerun = await run({ content: initial, issue: "Renamed column" });
    expect(rerun.isOk()).toBe(true);
    if (rerun.isErr()) {
      panic("Same-type materialization failed");
    }
    expect(rerun.value).toMatchObject({
      ok: true,
      materializedPropertyIds: [propertyId],
    });
    expect(
      await db.query.properties.findFirst({
        where: { id: { eq: propertyId } },
      }),
    ).toMatchObject({ name: "Renamed column", content: initial });
    expect(await countAuditEvents()).toBe(2);
  },
);
