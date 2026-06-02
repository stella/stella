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
  /**
   * Optional slash-command handle. Installed skills with a command
   * are surfaced as prompt-style items by the parallel
   * commandSkills feed; we filter them out of the skill section so
   * the same skill doesn't render twice (once as `/command` prompt
   * insert, once as `#stella-skill-ref` skill chip).
   * Built-in skills never carry a command.
   */
  command?: string | null;
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

  const {
    visibleRows: installedSkillRows,
    shadowSlugs: enabledInstalledSlugs,
  } = getChatVisibleInstalledSkillRows(skillPages);
  // Shadow the built-in row whenever an installed skill claims the
  // same slug — even if the installed row is omitted from the skill
  // list because it has a command. The backend `load-skill` resolves
  // by slug and would return the installed skill, so showing the
  // built-in description here would mislead the user about what the
  // slash item actually inserts.
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
): { visibleRows: SlashSkillRow[]; shadowSlugs: Set<string> } => {
  const installedRows = skillPages?.flatMap((page) => page.installed) ?? [];
  const visibleRows: SlashSkillRow[] = [];
  const seenSlugs = new Set<string>();
  // Apply the chat-metadata cap to enabled installed rows BEFORE
  // building either set, so we shadow the same window the backend
  // `load-skill` sees. Earlier-sorted rows beyond the cap are
  // invisible to the model too, so they must not block built-ins
  // and must not appear as skill chips.
  const chatVisibleEnabled = installedRows
    .filter((row) => row.enabled)
    .toSorted(compareChatInstalledSkillRows)
    .slice(0, CHAT_VISIBLE_INSTALLED_SKILL_LIMIT);
  // Every chat-visible installed slug shadows the built-in entry of
  // the same name — including ones that carry a command. The
  // backend load-skill resolves the slug to the installed row, so
  // rendering the built-in description would mislead the user about
  // what selecting it actually inserts.
  const shadowSlugs = new Set(chatVisibleEnabled.map((row) => row.slug));
  // Command-bearing installed skills are surfaced as prompt slash
  // items by the commandSkills feed; drop them from the skill-chip
  // list so the same skill doesn't appear twice in the menu.
  const chatMetadataRows = chatVisibleEnabled.filter((row) => !row.command);

  for (const row of chatMetadataRows) {
    if (seenSlugs.has(row.slug)) {
      continue;
    }
    seenSlugs.add(row.slug);
    visibleRows.push(row);
  }

  return { visibleRows, shadowSlugs };
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
