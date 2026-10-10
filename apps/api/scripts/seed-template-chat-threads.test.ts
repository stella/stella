import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  CHAT_THREAD_TITLE_MAX_LENGTH,
  chatThreads,
  templateChatThreads,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

import {
  buildTemplateChatSeedRows,
  seedTemplateChatThreads,
} from "./seed-template-chat-threads";

const organizationId = toSafeId<"organization">("org_seed");
const templates = [
  {
    id: toSafeId<"template">("00000000-0000-4000-8000-000000000001"),
    label: "tmpl-a",
    name: "Template A",
  },
  {
    id: toSafeId<"template">("00000000-0000-4000-8000-000000000002"),
    label: "tmpl-b",
    name: "Template B",
  },
  {
    id: toSafeId<"template">("00000000-0000-4000-8000-000000000003"),
    label: "tmpl-long",
    name: "T".repeat(CHAT_THREAD_TITLE_MAX_LENGTH + 20),
  },
];
const authorIds = ["user_a", "user_b"];
const seedRows = (templateRows: typeof templates) =>
  buildTemplateChatSeedRows({
    organizationId,
    templates: templateRows,
    authorIds,
  });

describe("seeded Template Studio chat associations", () => {
  test("creates stable global threads for every template and author", () => {
    const rows = seedRows(templates);

    expect(rows.threads).toHaveLength(6);
    expect(rows.mappings).toHaveLength(6);
    expect(new Set(rows.threads.map(({ id }) => id)).size).toBe(6);
    expect(new Set(rows.mappings.map(({ id }) => id)).size).toBe(6);
    for (const mapping of rows.mappings) {
      const matches = rows.threads.filter(
        (thread) =>
          thread.id === mapping.chatThreadId &&
          thread.organizationId === mapping.organizationId &&
          thread.userId === mapping.userId,
      );
      const template = templates.find(({ id }) => id === mapping.templateId);

      expect(matches).toHaveLength(1);
      expect(matches[0]?.title).toBe(
        template?.name.slice(0, CHAT_THREAD_TITLE_MAX_LENGTH),
      );
    }
    expect(
      rows.threads.every(
        ({ contextMatterIds, dataWorkspaceIds }) =>
          contextMatterIds.length === 0 && dataWorkspaceIds.length === 0,
      ),
    ).toBe(true);
    expect(
      rows.threads.find(
        ({ title }) => title.length === CHAT_THREAD_TITLE_MAX_LENGTH,
      )?.title,
    ).toBe("T".repeat(CHAT_THREAD_TITLE_MAX_LENGTH));

    const reversed = seedRows(templates.toReversed());
    expect(new Set(reversed.threads.map(({ id }) => id))).toEqual(
      new Set(rows.threads.map(({ id }) => id)),
    );
    expect(new Set(reversed.mappings.map(({ id }) => id))).toEqual(
      new Set(rows.mappings.map(({ id }) => id)),
    );
  });
  test("seeding twice preserves an existing association without creating orphan threads", async () => {
    const { testDb, ids } = await getRlsFixture();
    try {
      const input = {
        organizationId: ids.orgA,
        templates: [
          {
            id: ids.templateA,
            label: "existing-template",
            name: "Seeded template",
          },
        ],
        authorIds: [ids.userA1, ids.userA2],
      };
      const rows = buildTemplateChatSeedRows(input);
      const existingScope = and(
        eq(templateChatThreads.organizationId, ids.orgA),
        eq(templateChatThreads.templateId, ids.templateA),
        eq(templateChatThreads.userId, ids.userA1),
      );
      const readExistingAssociation = async () =>
        await testDb.select().from(templateChatThreads).where(existingScope);
      const readThreads = async () =>
        await testDb
          .select()
          .from(chatThreads)
          .where(eq(chatThreads.organizationId, ids.orgA))
          .orderBy(chatThreads.id);
      const beforeAssociation = await readExistingAssociation();
      expect(beforeAssociation).toHaveLength(1);
      expect(beforeAssociation.at(0)?.chatThreadId).toBe(
        ids.chatThreadGlobalA1,
      );
      const existingSeedThread = rows.threads.find(
        ({ userId }) => userId === ids.userA1,
      );
      expect(existingSeedThread).toBeDefined();
      expect(existingSeedThread?.id).not.toBe(ids.chatThreadGlobalA1);
      const beforeThreads = await readThreads();
      const newSeedThread = rows.threads.find(
        ({ userId }) => userId === ids.userA2,
      );
      expect(newSeedThread).toBeDefined();
      for (let pass = 0; pass < 2; pass += 1) {
        await withAggregateTransaction(
          testDb,
          async (tx) => await seedTemplateChatThreads(tx, input),
        );
        expect(await readExistingAssociation()).toEqual(beforeAssociation);
        const afterThreads = await readThreads();
        expect(
          afterThreads.filter(({ id }) => id !== newSeedThread?.id),
        ).toEqual(beforeThreads);
        expect(afterThreads).toHaveLength(beforeThreads.length + 1);
        expect(
          afterThreads.some(({ id }) => id === existingSeedThread?.id),
        ).toBe(false);
        const newAssociation = await testDb
          .select()
          .from(templateChatThreads)
          .where(
            and(
              eq(templateChatThreads.organizationId, ids.orgA),
              eq(templateChatThreads.templateId, ids.templateA),
              eq(templateChatThreads.userId, ids.userA2),
            ),
          );
        expect(newAssociation).toHaveLength(1);
        expect(newAssociation.at(0)?.chatThreadId).toBe(newSeedThread?.id);
      }
    } finally {
      await releaseRlsFixture();
    }
  });
});
