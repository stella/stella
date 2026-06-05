import type { SlashItem } from "@/components/chat/prompt-slash-extension";

export type SlashSectionKey = "private" | "team" | "built-in";

export type SlashItemGroup = {
  section: SlashSectionKey;
  items: SlashItem[];
};

const SECTION_ORDER: SlashSectionKey[] = ["private", "team", "built-in"];

const getSectionKey = (item: SlashItem): SlashSectionKey =>
  item.kind === "prompt" ? item.prompt.scope : item.skill.scope;

export const groupSlashItemsBySection = (
  items: SlashItem[],
): SlashItemGroup[] => {
  const groups = new Map<SlashSectionKey, SlashItem[]>();

  for (const item of items) {
    const key = getSectionKey(item);
    const list = groups.get(key);
    if (list) {
      list.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const result: SlashItemGroup[] = [];
  for (const section of SECTION_ORDER) {
    const group = groups.get(section);
    if (group && group.length > 0) {
      result.push({ section, items: group });
    }
  }
  return result;
};

export const getSlashItemsInRenderOrder = (
  groups: SlashItemGroup[],
): SlashItem[] => groups.flatMap((group) => group.items);
