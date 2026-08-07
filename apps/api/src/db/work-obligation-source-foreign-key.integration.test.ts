import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { entities, workObligations } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
const entityIds = new Set<ReturnType<typeof createSafeId<"entity">>>();

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  try {
    if (entityIds.size > 0) {
      await testDb.delete(entities).where(inArray(entities.id, [...entityIds]));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("work obligation source foreign key", () => {
  test("clears a deleted source without clearing workspace scope", async () => {
    const obligationEntityId = createSafeId<"entity">();
    const sourceEntityId = createSafeId<"entity">();
    entityIds.add(obligationEntityId);
    entityIds.add(sourceEntityId);
    await testDb.insert(entities).values([
      {
        id: obligationEntityId,
        workspaceId: ids.wsA2,
        kind: "task",
        name: "Provenance target",
      },
      {
        id: sourceEntityId,
        workspaceId: ids.wsA2,
        kind: "document",
        name: "Deletable provenance source",
      },
    ]);
    await testDb.insert(workObligations).values({
      entityId: obligationEntityId,
      workspaceId: ids.wsA2,
      sourceEntityId,
    });

    await testDb.delete(entities).where(eq(entities.id, sourceEntityId));

    expect(
      await testDb
        .select({
          sourceEntityId: workObligations.sourceEntityId,
          workspaceId: workObligations.workspaceId,
        })
        .from(workObligations)
        .where(eq(workObligations.entityId, obligationEntityId)),
    ).toEqual([{ sourceEntityId: null, workspaceId: ids.wsA2 }]);
  });

  test("still rejects a source from another workspace", async () => {
    const obligationEntityId = createSafeId<"entity">();
    entityIds.add(obligationEntityId);
    await testDb.insert(entities).values({
      id: obligationEntityId,
      workspaceId: ids.wsA2,
      kind: "task",
      name: "Cross-workspace provenance target",
    });

    const rejection: unknown = await testDb
      .insert(workObligations)
      .values({
        entityId: obligationEntityId,
        workspaceId: ids.wsA2,
        sourceEntityId: ids.entityA1,
      })
      .execute()
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(rejection).toBeInstanceOf(Error);
  });
});
