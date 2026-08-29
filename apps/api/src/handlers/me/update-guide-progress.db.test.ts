import { Value } from "@sinclair/typebox/value";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { user as authUser } from "@/api/db/auth-schema";
import type { rootDb } from "@/api/db/root";
import { createUpdateGuideProgressHandler } from "@/api/handlers/me/update-guide-progress";
import { toSafeId } from "@/api/lib/branded-types";
import { patchUserGuideProgress } from "@/api/lib/guide-progress";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

type UpdateGuideProgress = ReturnType<typeof createUpdateGuideProgressHandler>;
type UpdateGuideProgressCtx = Parameters<UpdateGuideProgress["handler"]>[0];

const userId = toSafeId<"user">(`guide-progress-${Bun.randomUUIDv7()}`);
const otherUserId = toSafeId<"user">(
  `guide-progress-other-${Bun.randomUUIDv7()}`,
);

let testDb: TestDatabase;
let updateGuideProgress: UpdateGuideProgress;

beforeAll(async () => {
  testDb = await getTestDb();
  const executeRootQuery = async (query: SQL) => {
    const result = await testDb.execute(query);
    return result.rows;
  };
  const database = asTestRaw<Pick<typeof rootDb, "execute">>({
    execute: executeRootQuery,
  });
  updateGuideProgress = createUpdateGuideProgressHandler(
    async (input) => await patchUserGuideProgress({ ...input, db: database }),
  );

  await testDb.insert(authUser).values([
    {
      id: userId,
      email: `${userId}@example.test`,
      name: "Guide progress test user",
    },
    {
      id: otherUserId,
      email: `${otherUserId}@example.test`,
      guideProgress: '{"chat":"completed"}',
      name: "Other guide progress test user",
    },
  ]);
});

afterAll(async () => {
  await testDb.delete(authUser).where(eq(authUser.id, userId));
  await testDb.delete(authUser).where(eq(authUser.id, otherUserId));
  await releaseTestDb();
});

const updateProgress = async (
  body: UpdateGuideProgressCtx["body"],
  currentUserId = userId,
) =>
  await updateGuideProgress.handler(
    asTestRaw<UpdateGuideProgressCtx>({
      body,
      request: new Request("https://example.test/v1/me/guide-progress", {
        method: "PATCH",
      }),
      route: "/v1/me/guide-progress",
      user: { id: currentUserId },
    }),
  );

const readProgress = async (id = userId): Promise<string | null> => {
  const row = (
    await testDb
      .select({ guideProgress: authUser.guideProgress })
      .from(authUser)
      .where(eq(authUser.id, id))
  ).at(0);
  return row?.guideProgress ?? null;
};

describe("guide progress request schema", () => {
  test("accepts only known tour and status pairs", () => {
    const schema = updateGuideProgress.config.body;

    expect(Value.Check(schema, { tourId: "chat", status: "completed" })).toBe(
      true,
    );
    expect(
      Value.Check(schema, { tourId: "unknown", status: "completed" }),
    ).toBe(false);
    expect(Value.Check(schema, { tourId: "chat", status: "unknown" })).toBe(
      false,
    );
    expect(
      Value.Check(schema, {
        tourId: "chat",
        status: "completed",
        replacementMap: {},
      }),
    ).toBe(false);
  });
});

describe("guide progress atomic patch", () => {
  test("initializes an empty map and returns the serialized result", async () => {
    const result = await updateProgress({
      tourId: "chat",
      status: "completed",
    });

    expect(result).toEqual({ guideProgress: '{"chat": "completed"}' });
    expect(JSON.parse((await readProgress()) ?? "null")).toEqual({
      chat: "completed",
    });
  });

  test("concurrent tour updates preserve both entries and existing keys", async () => {
    await testDb
      .update(authUser)
      .set({ guideProgress: '{"future-tour":"future-status"}' })
      .where(eq(authUser.id, userId));

    await Promise.all([
      updateProgress({ tourId: "documents", status: "skipped" }),
      updateProgress({ tourId: "playbooks", status: "completed" }),
    ]);

    expect(JSON.parse((await readProgress()) ?? "null")).toEqual({
      "future-tour": "future-status",
      documents: "skipped",
      playbooks: "completed",
    });
  });

  test("updates only the authenticated user's row", async () => {
    await updateProgress({ tourId: "workflows", status: "skipped" });

    expect(JSON.parse((await readProgress(otherUserId)) ?? "null")).toEqual({
      chat: "completed",
    });
  });
});
