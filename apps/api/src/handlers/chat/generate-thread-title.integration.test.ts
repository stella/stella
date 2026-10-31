import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { CHAT_TITLE_SOURCE, chatThreads } from "@/api/db/schema";
import type { ChatTitleSource } from "@/api/db/schema";
import { createScopedDb } from "@/api/db/scoped";
import {
  generateArtefact,
  writeThreadArtefactTitle,
} from "@/api/lib/ai-generation/provenance";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { readArtefactOrigin } from "@/api/lib/chat/artefact-provenance";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Exercise the production typed writer against the RLS fixture.

let testDb: TestDatabase;
let ids: TestIds;
const seededThreadIds: SafeId<"chatThread">[] = [];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
});

afterAll(async () => {
  if (seededThreadIds.length > 0) {
    await testDb
      .delete(chatThreads)
      .where(inArray(chatThreads.id, seededThreadIds));
  }
  await releaseRlsFixture();
});

const seedThread = async (
  titleSource?: ChatTitleSource,
): Promise<SafeId<"chatThread">> => {
  const threadId = toSafeId<"chatThread">(Bun.randomUUIDv7());
  await testDb.insert(chatThreads).values({
    id: threadId,
    organizationId: ids.orgA,
    userId: ids.userA1,
    title: "New chat",
    workspaceId: ids.wsA1,
    // Omit titleSource to observe the schema default.
    ...(titleSource ? { titleSource } : {}),
  });
  seededThreadIds.push(threadId);
  return threadId;
};

const readTitleState = async (threadId: SafeId<"chatThread">) => {
  const [row] = await testDb
    .select({
      title: chatThreads.title,
      titleSource: chatThreads.titleSource,
      generationProvenance: chatThreads.generationProvenance,
    })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row) {
    panic("Missing title fixture");
  }
  return row;
};

const runGeneratorWrite = async (
  threadId: SafeId<"chatThread">,
  title: string,
  initialTitle: string,
) => {
  const artefact = (
    await generateArtefact({
      generator: "apps/api/src/handlers/chat/generate-thread-title.ts",
      sources: { decisionIds: [], inputs: [] },
      generate: () => title,
    })
  ).unwrap();
  const updated = await createScopedDb(
    testDb,
    [ids.wsA1],
    ids.orgA,
    ids.userA1,
  )(
    async (tx) =>
      await writeThreadArtefactTitle({
        tx: asTestRaw(tx),
        threadId,
        artefact,
        expected: { title: initialTitle, source: CHAT_TITLE_SOURCE.DEFAULT },
        recordAuditEvent: async () => undefined,
      }),
  );
  return updated ? [{ id: threadId }] : [];
};

describe("chat thread title source", () => {
  test("a new thread defaults to the AI-replaceable 'default' source", async () => {
    const threadId = await seedThread();
    const { titleSource } = await readTitleState(threadId);
    expect(titleSource).toBe(CHAT_TITLE_SOURCE.DEFAULT);
  });

  test("generator write replaces a default-source title and stamps 'ai'", async () => {
    const threadId = await seedThread();
    const updated = await runGeneratorWrite(
      threadId,
      "Contract review",
      "New chat",
    );
    expect(updated).toHaveLength(1);

    const { title, titleSource, generationProvenance } =
      await readTitleState(threadId);
    expect(readArtefactOrigin(generationProvenance, "title")).toMatchObject({
      type: "generated",
      decisionIds: [],
    });
    expect(title).toBe("Contract review");
    expect(titleSource).toBe(CHAT_TITLE_SOURCE.AI);
  });

  test("generator write does not clobber a user rename", async () => {
    const threadId = await seedThread(CHAT_TITLE_SOURCE.USER);
    const updated = await runGeneratorWrite(
      threadId,
      "AI generated title",
      "New chat",
    );
    expect(updated).toHaveLength(0);

    const { title, titleSource } = await readTitleState(threadId);
    expect(title).toBe("New chat");
    expect(titleSource).toBe(CHAT_TITLE_SOURCE.USER);
  });

  test("generator write does not regenerate over a prior ai title", async () => {
    const threadId = await seedThread(CHAT_TITLE_SOURCE.AI);
    const updated = await runGeneratorWrite(
      threadId,
      "Second title",
      "New chat",
    );
    expect(updated).toHaveLength(0);

    const { titleSource } = await readTitleState(threadId);
    expect(titleSource).toBe(CHAT_TITLE_SOURCE.AI);
  });

  // Rolling-deploy window: an old API task's rename-thread implementation
  // predates titleSource and writes only `title`, leaving titleSource
  // "default" behind. The generator must not treat that stale column as
  // license to overwrite the rename — it also has to notice the title text
  // no longer matches what it observed when the background job started.
  test("generator write does not clobber a rename left by a pre-migration rename-thread", async () => {
    const threadId = await seedThread();

    // Simulate the old rename-thread handler: it only ever touched `title`,
    // so titleSource stays "default" even though the user did rename.
    await testDb
      .update(chatThreads)
      .set({ title: "Renamed by old task" })
      .where(eq(chatThreads.id, threadId));

    const updated = await runGeneratorWrite(
      threadId,
      "AI generated title",
      "New chat",
    );
    expect(updated).toHaveLength(0);

    const { title, titleSource } = await readTitleState(threadId);
    expect(title).toBe("Renamed by old task");
    expect(titleSource).toBe(CHAT_TITLE_SOURCE.DEFAULT);
  });
});
