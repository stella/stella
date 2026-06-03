import { describe, expect, test } from "bun:test";

import { buildChatSlashItems } from "@/components/chat-editor-slash-items";

describe("buildChatSlashItems", () => {
  test("includes built-in skills when no installed skill shadows them", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          builtIn: [
            {
              description: "Review a clause.",
              enabled: true,
              id: "review-clause",
              name: "review-clause",
              scope: "built-in",
              slug: "review-clause",
            },
          ],
          installed: [],
        },
      ],
    });

    expect(items).toEqual([
      {
        kind: "skill",
        skill: {
          description: "Review a clause.",
          id: "review-clause",
          name: "review-clause",
          scope: "built-in",
          slug: "review-clause",
        },
      },
    ]);
  });

  test("includes installed skills from every fetched page", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          builtIn: [],
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
          builtIn: [],
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
          builtIn: [
            skillRow({
              description: "Built-in fallback.",
              id: "zz-over-limit",
              scope: "built-in",
              slug: "zz-over-limit",
            }),
          ],
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
    expect(items).toContainEqual({
      kind: "skill",
      skill: {
        description: "Built-in fallback.",
        id: "zz-over-limit",
        name: "zz-over-limit",
        scope: "built-in",
        slug: "zz-over-limit",
      },
    });
  });

  test("uses the private installed skill when private and team skills share a slug", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          builtIn: [],
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

  test("hides built-in skills shadowed by enabled installed skills", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          builtIn: [
            {
              description: "Built-in.",
              enabled: true,
              id: "summarize",
              name: "summarize",
              scope: "built-in",
              slug: "summarize",
            },
          ],
          installed: [
            {
              description: "Team override.",
              enabled: true,
              id: "installed-summarize",
              name: "Summarize",
              scope: "team",
              slug: "summarize",
            },
          ],
        },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "skill",
      skill: { id: "installed-summarize", slug: "summarize" },
    });
  });

  test("command-bearing installed skill still shadows a same-slug built-in", () => {
    // Without shadowing, the built-in row would render its own
    // description while load-skill resolves the slug to the installed
    // (custom) skill — misleading the user about what they invoke.
    const items = buildChatSlashItems({
      shortcuts: [
        {
          id: "summarize-default",
          scope: "private",
          name: "Custom summarise",
          command: "summarize",
          prompt: "Custom body…",
        },
      ],
      skillPages: [
        {
          builtIn: [
            {
              description: "Built-in summarise.",
              enabled: true,
              id: "summarize",
              name: "summarize",
              scope: "built-in",
              slug: "summarize",
            },
          ],
          installed: [
            {
              description: "Custom summarise — shadows the built-in.",
              enabled: true,
              id: "summarize-default",
              name: "Custom summarise",
              scope: "private",
              slug: "summarize",
              command: "summarize",
            },
          ],
        },
      ],
    });

    expect(items.some((item) => item.kind === "skill")).toBe(false);
    expect(items).toEqual([
      {
        kind: "prompt",
        prompt: {
          id: "summarize-default",
          scope: "private",
          name: "Custom summarise",
          command: "summarize",
          body: "Custom body…",
        },
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
          builtIn: [],
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

  test("keeps built-in skills shadowed only by disabled installed skills", () => {
    const items = buildChatSlashItems({
      shortcuts: [],
      skillPages: [
        {
          builtIn: [
            {
              description: "Built-in.",
              enabled: true,
              id: "draft",
              name: "draft",
              scope: "built-in",
              slug: "draft",
            },
          ],
          installed: [
            {
              description: "Disabled override.",
              enabled: false,
              id: "installed-draft",
              name: "Draft",
              scope: "private",
              slug: "draft",
            },
          ],
        },
      ],
    });

    expect(items).toEqual([
      {
        kind: "skill",
        skill: {
          description: "Built-in.",
          id: "draft",
          name: "draft",
          scope: "built-in",
          slug: "draft",
        },
      },
    ]);
  });
});

type SkillRowInput = {
  description?: string;
  enabled?: boolean;
  id: string;
  name?: string;
  scope?: "built-in" | "private" | "team";
  slug: string;
};

const skillRow = ({
  description = "Skill description.",
  enabled = true,
  id,
  name,
  scope = "private",
  slug,
}: SkillRowInput) => ({
  description,
  enabled,
  id,
  name: name ?? slug,
  scope,
  slug,
});
