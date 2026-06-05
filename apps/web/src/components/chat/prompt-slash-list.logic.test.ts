import { describe, expect, test } from "bun:test";

import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import {
  getSlashItemsInRenderOrder,
  groupSlashItemsBySection,
} from "@/components/chat/prompt-slash-list.logic";

describe("prompt slash list ordering", () => {
  test("matches selection order to grouped render order", () => {
    const teamSkill = skillItem({
      id: "team-review",
      name: "Team review",
      scope: "team",
    });
    const builtInSkill = skillItem({
      id: "built-in-summary",
      name: "Built-in summary",
      scope: "built-in",
    });
    const privatePrompt = promptItem({
      id: "private-draft",
      name: "Private draft",
      scope: "private",
    });

    const groups = groupSlashItemsBySection([
      teamSkill,
      builtInSkill,
      privatePrompt,
    ]);

    expect(groups.map((group) => group.section)).toEqual([
      "private",
      "team",
      "built-in",
    ]);
    expect(getSlashItemsInRenderOrder(groups).map(getItemId)).toEqual([
      "private-draft",
      "team-review",
      "built-in-summary",
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
  scope: "private" | "team" | "built-in";
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

const getItemId = (item: SlashItem): string =>
  item.kind === "prompt" ? item.prompt.id : item.skill.id;
