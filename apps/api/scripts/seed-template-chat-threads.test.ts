import { describe, expect, test } from "bun:test";

import { CHAT_THREAD_TITLE_MAX_LENGTH } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";

import { buildTemplateChatSeedRows } from "./seed-template-chat-threads";

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
});
