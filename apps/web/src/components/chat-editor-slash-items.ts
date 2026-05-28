import type {
  SlashItem,
  SlashSkillScope,
} from "@/components/chat/prompt-slash-extension";
import type { ChatPrompt } from "@/lib/prompts/types";

type SlashShortcutRow = Pick<
  ChatPrompt,
  "command" | "id" | "name" | "scope"
> & {
  prompt: string;
};

type SlashSkillRow = {
  description: string;
  enabled: boolean;
  id: string;
  name: string;
  scope: SlashSkillScope;
  slug: string;
};

type SlashSkillPage = {
  builtIn: readonly SlashSkillRow[];
  installed: readonly SlashSkillRow[];
};

// Mirrors LIMITS.agentSkillsChatMetadataMax on the API side. The chat backend
// only exposes this many enabled installed skills to `load-skill`.
const CHAT_VISIBLE_INSTALLED_SKILL_LIMIT = 200;

type BuildChatSlashItemsInput = {
  shortcuts: readonly SlashShortcutRow[];
  skillPages: readonly SlashSkillPage[] | undefined;
};

export const buildChatSlashItems = ({
  shortcuts,
  skillPages,
}: BuildChatSlashItemsInput): SlashItem[] => {
  const promptItems: SlashItem[] = shortcuts.map((shortcut) => ({
    kind: "prompt" as const,
    prompt: {
      id: shortcut.id,
      scope: shortcut.scope,
      name: shortcut.name,
      command: shortcut.command,
      body: shortcut.prompt,
    },
  }));

  const installedSkillRows = getChatVisibleInstalledSkillRows(skillPages);
  const enabledInstalledSlugs = new Set(
    installedSkillRows.map((row) => row.slug),
  );
  const builtInSkillRows =
    skillPages
      ?.at(0)
      ?.builtIn.filter((row) => !enabledInstalledSlugs.has(row.slug)) ?? [];
  const skillRows = [...builtInSkillRows, ...installedSkillRows];
  const skillItems: SlashItem[] = skillRows
    .filter((row) => row.enabled)
    .map((row) => ({
      kind: "skill" as const,
      skill: {
        id: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        scope: row.scope,
      },
    }));

  return [...promptItems, ...skillItems];
};

const getChatVisibleInstalledSkillRows = (
  skillPages: readonly SlashSkillPage[] | undefined,
): SlashSkillRow[] => {
  const installedRows = skillPages?.flatMap((page) => page.installed) ?? [];
  const visibleRows: SlashSkillRow[] = [];
  const seenSlugs = new Set<string>();
  const chatMetadataRows = installedRows
    .filter((row) => row.enabled)
    .toSorted(compareChatInstalledSkillRows)
    .slice(0, CHAT_VISIBLE_INSTALLED_SKILL_LIMIT);

  for (const row of chatMetadataRows) {
    if (seenSlugs.has(row.slug)) {
      continue;
    }
    seenSlugs.add(row.slug);
    visibleRows.push(row);
  }

  return visibleRows;
};

const compareChatInstalledSkillRows = (
  left: SlashSkillRow,
  right: SlashSkillRow,
): number =>
  compareSkillScope(left.scope, right.scope) ||
  compareString(left.slug, right.slug) ||
  compareString(left.id, right.id);

const compareSkillScope = (
  left: SlashSkillScope,
  right: SlashSkillScope,
): number => scopePriority(left) - scopePriority(right);

const scopePriority = (scope: SlashSkillScope): number => {
  switch (scope) {
    case "private":
      return 0;
    case "team":
      return 1;
    case "built-in":
      return 2;
    default:
      scope satisfies never;
      return 2;
  }
};

const compareString = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};
