import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { inArray } from "drizzle-orm";

import { entities } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { queryEntities } from "@/api/lib/entities/query-entities";
import type { EntityQueryScope } from "@/api/lib/entities/query-scope";
import type { EntitiesWindowCursorValues } from "@/api/lib/entities/window-cursor";
import { getRlsFixture, releaseRlsFixture } from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => await releaseRlsFixture());

type ReadScopeOptions = {
  scope: EntityQueryScope;
  workspaceIds?: SafeId<"workspace">[];
  cursor?: EntitiesWindowCursorValues;
  limit?: number;
};

const readScope = async ({
  scope,
  workspaceIds = [ids.wsA1, ids.wsA2, ids.wsB1],
  cursor,
  limit = 10,
}: ReadScopeOptions) => {
  const result = await queryEntities({
    safeDb: createSafeDb(testDb, workspaceIds, ids.orgA, ids.userA1),
    scope,
    currentUserId: ids.userA1,
    currentOrganizationId: ids.orgA,
    filters: [],
    sorts: [],
    cursor,
    limit,
    fieldMode: "full",
    fieldIds: [],
    includeAssignees: true,
    extraConditions: [
      inArray(entities.id, [ids.entityA1, ids.entityA2, ids.entityB1]),
    ],
  });
  if (result.isErr()) throw result.error;
  return result.value;
};

describe("canonical entity query scope", () => {
  test("an organization page equals its authorized matter pages with full hydration", async () => {
    const organization = await readScope({
      scope: { type: "organization", organizationId: ids.orgA },
    });
    const matterPages = await Promise.all(
      [ids.wsA1, ids.wsA2].map((workspaceId) =>
        readScope({ scope: { type: "matter", workspaceId } }),
      ),
    );
    const expected = matterPages.flatMap((page) => page.entities);
    expect(
      new Set(organization.entities.map(({ entityId }) => entityId)),
    ).toEqual(new Set([ids.entityA1, ids.entityA2]));
    for (const row of organization.entities) {
      expect(row).toEqual(
        expected.find(({ entityId }) => entityId === row.entityId),
      );
      expect(row.workspaceName.length).toBeGreaterThan(0);
      expect(row.fields.length).toBeGreaterThan(0);
    }
  });

  test("organization scope cannot widen the supplied RLS matter authorization", async () => {
    const page = await readScope({
      scope: { type: "organization", organizationId: ids.orgA },
      workspaceIds: [ids.wsA2],
    });
    expect(page.entities.map(({ entityId }) => entityId)).toEqual([ids.entityA2]);
    expect(page.entities.at(0)?.workspaceId).toBe(ids.wsA2);
  });

  test("the canonical cursor partitions a page spanning matters", async () => {
    const scope = { type: "organization", organizationId: ids.orgA } as const;
    const whole = await readScope({ scope });
    const first = await readScope({ scope, limit: 1 });
    const boundary = first.entities.at(0);
    if (!boundary) return expect.unreachable("Expected a first entity");
    const cursor = first.cursorValuesByEntityId.get(boundary.entityId);
    if (!cursor) return expect.unreachable("Expected a cursor for the first entity");
    const second = await readScope({ scope, cursor, limit: 1 });
    expect(
      [...first.entities, ...second.entities].map(({ entityId }) => entityId),
    ).toEqual(whole.entities.map(({ entityId }) => entityId));
  });
});
