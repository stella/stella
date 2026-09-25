import { describe, expect, test } from "bun:test";

import {
  buildChatSlashItems,
  commandShortcutRowsFromSkillPages,
} from "@/components/chat-editor-slash-items";

describe("buildChatSlashItems", () => {
  test("includes reserved commands only for chat composers that support them", () => {
    const withoutReserved = buildChatSlashItems({
      shortcuts: [],
      skillPages: [],
    });
    const withReserved = buildChatSlashItems({
      shortcuts: [],
      skillPages: [],
      reservedCommands: { hasPersistedThread: true },
    });

    expect(withoutReserved).toEqual([]);
    expect(withReserved).toEqual([
      {
        kind: "command",
        command: {
          command: "/new",
          descriptionKey: "chat.newChat",
          id: "new",
          name: "new",
        },
      },
      {
        kind: "command",
        command: {
          command: "/rename-chat",
          descriptionKey: "chat.renameThread",
          id: "rename-chat",
          name: "rename-chat",
        },
      },
    ]);
  });

  test("offers /rename-chat only when the composer has a persisted thread", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [],
      reservedCommands: { hasPersistedThread: false },
    });

    expect(
      items.map((item) => (item.kind === "command" ? item.command.id : "")),
    ).toEqual(["new"]);
  });

  test("includes installed skills from every fetched page", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          installed: [
            {
              description: "First page.",
              enabled: true,
              id: "installed-1",
              name: "Installed 1",
              scope: "team",
              slug: "installed-1",
            },
          ],
        },
        {
          installed: [
            {
              description: "Second page.",
              enabled: true,
              id: "installed-2",
              name: "Installed 2",
              scope: "team",
              slug: "installed-2",
            },
          ],
        },
      ],
    });

    expect(
      items.map((item) => (item.kind === "skill" ? item.skill.slug : "")),
    ).toEqual(["installed-1", "installed-2"]);
  });

  test("excludes installed skills outside the backend chat metadata cap", () => {
    const visibleInstalled = Array.from({ length: 200 }, (_, index) =>
      skillRow({
        id: `installed-${index.toString().padStart(3, "0")}`,
        slug: `allowed-${index.toString().padStart(3, "0")}`,
      }),
    );
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          installed: [
            ...visibleInstalled,
            skillRow({
              description: "Outside chat metadata cap.",
              id: "installed-over-limit",
              slug: "zz-over-limit",
            }),
          ],
        },
      ],
    });

    expect(
      items.some(
        (item) =>
          item.kind === "skill" && item.skill.id === "installed-over-limit",
      ),
    ).toBe(false);
    expect(items).toHaveLength(visibleInstalled.length);
  });

  test("uses the private installed skill when private and team skills share a slug", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          installed: [
            skillRow({
              description: "Team version.",
              id: "team-summarize",
              scope: "team",
              slug: "summarize",
            }),
            skillRow({
              description: "Private version.",
              id: "private-summarize",
              scope: "private",
              slug: "summarize",
            }),
          ],
        },
      ],
    });

    expect(items).toEqual([
      {
        kind: "skill",
        skill: {
          description: "Private version.",
          id: "private-summarize",
          name: "summarize",
          scope: "private",
          slug: "summarize",
        },
      },
    ]);
  });

  test("derives prompt rows from command-bearing skill pages", () => {
    const rows = commandShortcutRowsFromSkillPages([
      {
        installed: [
          skillRow({
            body: "Summarise this document.",
            command: "summarize",
            id: "summarize-default",
            name: "Summarise",
            scope: "private",
            slug: "summarize-default",
          }),
          skillRow({
            body: "Disabled body.",
            command: "disabled",
            enabled: false,
            id: "disabled-command",
            slug: "disabled-command",
          }),
          skillRow({
            body: null,
            command: "missing-body",
            id: "missing-body",
            slug: "missing-body",
          }),
        ],
      },
    ]);

    expect(rows).toEqual([
      {
        id: "summarize-default",
        scope: "private",
        name: "Summarise",
        command: "summarize",
        prompt: "Summarise this document.",
      },
    ]);
  });

  test("hides installed skills that carry a slash command (covered by prompt feed)", () => {
    const items = buildChatSlashItems({
      shortcuts: [
        {
          id: "summarize-default",
          scope: "private",
          name: "Summarise a document",
          command: "summarize",
          prompt: "Summarise...",
        },
      ],
      skillPages: [
        {
          installed: [
            {
              description: "Same skill that backs /summarize.",
              enabled: true,
              id: "summarize-default",
              name: "Summarise a document",
              scope: "private",
              slug: "summarize-default",
              command: "summarize",
            },
          ],
        },
      ],
    });

    expect(items).toEqual([
      {
        kind: "prompt",
        prompt: {
          id: "summarize-default",
          scope: "private",
          name: "Summarise a document",
          command: "summarize",
          body: "Summarise...",
        },
      },
    ]);
  });

  test("omits disabled installed skills", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          installed: [
            skillRow({ enabled: false, id: "installed-draft", slug: "draft" }),
          ],
        },
      ],
    });

    expect(items).toEqual([]);
  });
});

type SkillRowInput = {
  body?: string | null;
  command?: string | null;
  description?: string;
  enabled?: boolean;
  id: string;
  name?: string;
  scope?: "private" | "team";
  slug: string;
};

const skillRow = ({
  body,
  command,
  description = "Skill description.",
  enabled = true,
  id,
  name,
  scope = "private",
  slug,
}: SkillRowInput) => ({
  ...(body === undefined ? {} : { body }),
  ...(command === undefined ? {} : { command }),
  description,
  enabled,
  id,
  name: name ?? slug,
  scope,
  slug,
});
