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

  const installedSkillRows =
    skillPages?.flatMap((page) => page.installed) ?? [];
  const enabledInstalledSlugs = new Set(
    installedSkillRows.filter((row) => row.enabled).map((row) => row.slug),
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
