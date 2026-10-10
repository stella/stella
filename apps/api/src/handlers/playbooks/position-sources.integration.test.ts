/**
 * Who may attach a source document to a playbook position.
 *
 * A playbook is visible to the whole organization; a source is a document in
 * one matter. The save rule (`assertPositionsValid`) lets a saver introduce
 * only a document their own transaction can read, in the matter it truly
 * belongs to, and carries a source the playbook already stores. Only
 * PostgreSQL decides what a transaction can read (row security), so the rule
 * is exercised against a real schema with two users of one organization: A1
 * can open both matters, A2 only the second.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { entities, playbookDefinitions } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import approvePlaybookDefinition from "@/api/handlers/playbooks/approve";
import createPlaybookDefinition from "@/api/handlers/playbooks/create";
import getPlaybookDefinition from "@/api/handlers/playbooks/get";
import updatePlaybookDefinition from "@/api/handlers/playbooks/update";
import restorePlaybookVersion from "@/api/handlers/playbooks/versions/restore";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type {
  PlaybookPositions,
  PositionSource,
} from "@/api/lib/workflow/playbook-positions";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

const DELETED_ENTITY_ID = toSafeId<"entity">(
  "66666666-6666-4666-8666-666666666661",
);
const POSITION_ID = "66666666-6666-4666-8666-666666666662";
const createdPlaybookIds: SafeId<"playbookDefinition">[] = [];

const noopAuditRecorder: AuditRecorder = async () => undefined;

type Actor = "a1" | "a2";

const contextFor = (actor: Actor) => ({
  createAuditRecorder: () => noopAuditRecorder,
  getActiveWorkspaceIds: async () =>
    actor === "a1" ? [ids.wsA1, ids.wsA2] : [ids.wsA2],
  getWorkspaceAccess: async () => null,
  memberRole: sessionMemberRole("owner"),
  orgAIConfig: null,
  orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
  promptCachingEnabled: false,
  recordAuditEvent: noopAuditRecorder,
  request: new Request("https://example.test/playbooks"),
  route: "/playbooks",
  safeDb:
    actor === "a1"
      ? createSafeDb(testDb, [ids.wsA1, ids.wsA2], ids.orgA, ids.userA1)
      : createSafeDb(testDb, [ids.wsA2], ids.orgA, ids.userA2),
  session: { activeOrganizationId: ids.orgA },
  user: { id: actor === "a1" ? ids.userA1 : ids.userA2 },
});

const positionsCiting = (
  sources: PositionSource[] | undefined,
  issue = "Governing law",
): PlaybookPositions => ({
  version: 3,
  items: [
    {
      mode: "extract",
      sourceId: POSITION_ID,
      issue,
      ask: { question: "", content: { version: 1, type: "text" } },
      ...(sources === undefined ? {} : { sources }),
      enabled: true,
    },
  ],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const statusOf = (result: unknown): number | null => {
  if (!isRecord(result)) {
    return null;
  }
  for (const field of ["status", "statusCode", "code"] as const) {
    const value = result[field];
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
};

const create = async (
  actor: Actor,
  positions: PlaybookPositions,
): Promise<unknown> => {
  const result: unknown = await createPlaybookDefinition.handler(
    asTestRaw<Parameters<typeof createPlaybookDefinition.handler>[0]>({
      ...contextFor(actor),
      body: { name: "Sources", positions },
    }),
  );
  if (isRecord(result) && typeof result["id"] === "string") {
    createdPlaybookIds.push(toSafeId<"playbookDefinition">(result["id"]));
  }
  return result;
};

const createdBy = async (
  actor: Actor,
  positions: PlaybookPositions,
): Promise<SafeId<"playbookDefinition">> => {
  const result = await create(actor, positions);
  if (!isRecord(result) || typeof result["id"] !== "string") {
    throw new TypeError("expected the playbook to be created");
  }
  return toSafeId<"playbookDefinition">(result["id"]);
};

const update = async (
  actor: Actor,
  playbookId: SafeId<"playbookDefinition">,
  positions: PlaybookPositions,
): Promise<unknown> =>
  await updatePlaybookDefinition.handler(
    asTestRaw<Parameters<typeof updatePlaybookDefinition.handler>[0]>({
      ...contextFor(actor),
      params: { playbookId },
      body: { name: "Sources", positions },
    }),
  );

const storedSources = async (playbookId: SafeId<"playbookDefinition">) => {
  const rows = await testDb
    .select({ positions: playbookDefinitions.positions })
    .from(playbookDefinitions)
    .where(eq(playbookDefinitions.id, playbookId));
  return rows.at(0)?.positions.items.at(0)?.sources;
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.insert(entities).values({
    id: DELETED_ENTITY_ID,
    workspaceId: ids.wsA1,
    kind: "document",
    name: "to be deleted",
  });
});

afterAll(async () => {
  try {
    await testDb.delete(entities).where(eq(entities.id, DELETED_ENTITY_ID));
    if (createdPlaybookIds.length > 0) {
      await testDb
        .delete(playbookDefinitions)
        .where(inArray(playbookDefinitions.id, createdPlaybookIds));
    }
  } finally {
    await releaseRlsFixture();
  }
});

describe("playbook position sources: the save rule", () => {
  test("a saver introduces a source from a matter they can open", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    const playbookId = await createdBy("a1", positionsCiting([source]));
    expect(await storedSources(playbookId)).toEqual([source]);
  });

  test("a create cannot introduce a source from a matter the saver cannot open", async () => {
    const result = await create(
      "a2",
      positionsCiting([{ workspaceId: ids.wsA1, entityId: ids.entityA1 }]),
    );
    expect(statusOf(result)).toBe(403);
  });

  test("an update cannot introduce a source from a matter the saver cannot open", async () => {
    const playbookId = await createdBy("a1", positionsCiting(undefined));
    const result = await update(
      "a2",
      playbookId,
      positionsCiting([{ workspaceId: ids.wsA1, entityId: ids.entityA1 }]),
    );
    expect(statusOf(result)).toBe(403);
    expect(await storedSources(playbookId)).toBeUndefined();
  });

  test("another organization's document is refused like any unreadable one", async () => {
    const result = await create(
      "a1",
      positionsCiting([{ workspaceId: ids.wsB1, entityId: ids.entityB1 }]),
    );
    expect(statusOf(result)).toBe(403);
  });

  test("a readable document paired with the wrong matter is refused", async () => {
    // A2 can read entityA2; claiming it lives in wsA1 would let a client
    // choose which matter a reader is pointed at.
    const result = await create(
      "a2",
      positionsCiting([{ workspaceId: ids.wsA1, entityId: ids.entityA2 }]),
    );
    expect(statusOf(result)).toBe(403);
  });

  test("a colleague who cannot open the source matter still edits the playbook, and the source is carried", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    const playbookId = await createdBy("a1", positionsCiting([source]));

    const result = await update(
      "a2",
      playbookId,
      positionsCiting([source], "Governing law and venue"),
    );

    expect(statusOf(result)).toBeNull();
    expect(await storedSources(playbookId)).toEqual([source]);
  });

  test("a carried source does not let the saver add another unreadable one beside it", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    const playbookId = await createdBy("a1", positionsCiting([source]));

    const result = await update(
      "a2",
      playbookId,
      positionsCiting([
        source,
        { workspaceId: ids.wsA1, entityId: DELETED_ENTITY_ID },
      ]),
    );

    expect(statusOf(result)).toBe(403);
    expect(await storedSources(playbookId)).toEqual([source]);
  });

  test("a stored source in one playbook cannot be carried into another", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    await createdBy("a1", positionsCiting([source]));
    const otherPlaybookId = await createdBy("a2", positionsCiting(undefined));

    const result = await update(
      "a2",
      otherPlaybookId,
      positionsCiting([source]),
    );

    expect(statusOf(result)).toBe(403);
  });

  test("a source whose document was deleted is carried", async () => {
    const source = { workspaceId: ids.wsA1, entityId: DELETED_ENTITY_ID };
    const playbookId = await createdBy("a1", positionsCiting([source]));
    await testDb.delete(entities).where(eq(entities.id, DELETED_ENTITY_ID));

    const result = await update(
      "a1",
      playbookId,
      positionsCiting([source], "Governing law and venue"),
    );

    expect(statusOf(result)).toBeNull();
    expect(await storedSources(playbookId)).toEqual([source]);
  });
});

describe("playbook position sources: restoring a version", () => {
  /** Approve as A1, which snapshots the current positions as version 1. */
  const approve = async (playbookId: SafeId<"playbookDefinition">) => {
    const rows = await testDb
      .select({ updatedAt: playbookDefinitions.updatedAt })
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.id, playbookId));
    const result: unknown = await approvePlaybookDefinition.handler(
      asTestRaw<Parameters<typeof approvePlaybookDefinition.handler>[0]>({
        ...contextFor("a1"),
        params: { playbookId },
        body: { expectedUpdatedAt: rows.at(0)?.updatedAt.toISOString() },
      }),
    );
    expect(statusOf(result)).toBeNull();
  };

  const restore = async (
    actor: Actor,
    playbookId: SafeId<"playbookDefinition">,
  ): Promise<unknown> =>
    await restorePlaybookVersion.handler(
      asTestRaw<Parameters<typeof restorePlaybookVersion.handler>[0]>({
        ...contextFor(actor),
        params: { playbookId, version: 1 },
      }),
    );

  /** Version 1 cites `source`; the current definition no longer does. */
  const withSnapshotOnlySource = async (source: PositionSource) => {
    const playbookId = await createdBy("a1", positionsCiting([source]));
    await approve(playbookId);
    expect(
      statusOf(await update("a1", playbookId, positionsCiting(undefined))),
    ).toBeNull();
    expect(await storedSources(playbookId)).toBeUndefined();
    return playbookId;
  };

  test("a restore cannot bring back a source the restorer cannot read", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    const playbookId = await withSnapshotOnlySource(source);

    const result = await restore("a2", playbookId);

    expect(statusOf(result)).toBe(403);
    expect(await storedSources(playbookId)).toBeUndefined();
  });

  test("a restore brings back a source the restorer can read", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    const playbookId = await withSnapshotOnlySource(source);

    const result = await restore("a1", playbookId);

    expect(statusOf(result)).toBeNull();
    expect(await storedSources(playbookId)).toEqual([source]);
  });

  test("a restore carries a source the current definition still stores", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    const playbookId = await createdBy("a1", positionsCiting([source]));
    await approve(playbookId);
    await update(
      "a1",
      playbookId,
      positionsCiting([source], "Governing law and venue"),
    );

    const result = await restore("a2", playbookId);

    expect(statusOf(result)).toBeNull();
    expect(await storedSources(playbookId)).toEqual([source]);
    const rows = await testDb
      .select({ positions: playbookDefinitions.positions })
      .from(playbookDefinitions)
      .where(eq(playbookDefinitions.id, playbookId));
    expect(rows.at(0)?.positions.items.at(0)?.issue).toBe("Governing law");
  });
});

describe("playbook position sources: what each reader is answered", () => {
  const read = async (
    actor: Actor,
    playbookId: SafeId<"playbookDefinition">,
  ): Promise<Record<string, unknown>> => {
    const result: unknown = await getPlaybookDefinition.handler(
      asTestRaw<Parameters<typeof getPlaybookDefinition.handler>[0]>({
        ...contextFor(actor),
        params: { playbookId },
      }),
    );
    if (!isRecord(result) || statusOf(result) !== null) {
      throw new TypeError("expected the playbook to be read");
    }
    return result;
  };

  test("the overlay names a source only for a reader who can open its matter", async () => {
    const source = { workspaceId: ids.wsA1, entityId: ids.entityA1 };
    const playbookId = await createdBy("a1", positionsCiting([source]));

    const forAuthor = await read("a1", playbookId);
    expect(forAuthor["positionSources"]).toEqual([
      { ...source, name: "entityA1", workspaceName: "WS A1" },
    ]);

    const forColleague = await read("a2", playbookId);
    expect(forColleague["positionSources"]).toEqual([]);
    // Nothing the colleague is answered carries the document's or the
    // matter's name; the positions themselves are the same for both readers.
    expect(JSON.stringify(forColleague)).not.toContain("entityA1");
    expect(JSON.stringify(forColleague)).not.toContain("WS A1");
    expect(forColleague["positions"]).toEqual(forAuthor["positions"]);
  });
});
