import { describe, expect, test } from "bun:test";

import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import {
  getSlashItemsInRenderOrder,
  groupSlashItemsBySection,
} from "@/components/chat/prompt-slash-list.logic";
import { getReservedChatCommands } from "@/lib/reserved-chat-commands";

describe("prompt slash list ordering", () => {
  test("matches selection order to grouped render order", () => {
    const teamSkill = skillItem({
      id: "team-review",
      name: "Team review",
      scope: "team",
    });
    const commandItems: SlashItem[] = getReservedChatCommands({
      hasPersistedThread: false,
    }).map((command) => ({ kind: "command", command }));
    const privatePrompt = promptItem({
      id: "private-draft",
      name: "Private draft",
      scope: "private",
    });

    const groups = groupSlashItemsBySection([
      teamSkill,
      ...commandItems,
      privatePrompt,
    ]);

    expect(groups.map((group) => group.section)).toEqual([
      "private",
      "team",
      "commands",
    ]);
    expect(getSlashItemsInRenderOrder(groups).map(getItemId)).toEqual([
      "private-draft",
      "team-review",
      "new",
    ]);
  });
});

type PromptItemInput = {
  id: string;
  name: string;
  scope: "private" | "team";
};

const promptItem = ({ id, name, scope }: PromptItemInput): SlashItem => ({
  kind: "prompt",
  prompt: {
    body: `${name} body`,
    command: name.toLowerCase().replaceAll(" ", "-"),
    id,
    name,
    scope,
  },
});

type SkillItemInput = {
  id: string;
  name: string;
  scope: "private" | "team";
};

const skillItem = ({ id, name, scope }: SkillItemInput): SlashItem => ({
  kind: "skill",
  skill: {
    description: `${name} description`,
    id,
    name,
    scope,
    slug: id,
  },
});

const getItemId = (item: SlashItem): string => {
  if (item.kind === "prompt") {
    return item.prompt.id;
  }
  if (item.kind === "skill") {
    return item.skill.id;
  }
  return item.command.id;
};
