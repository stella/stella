import { panic } from "better-result";

import { AGENT_SKILLS_CHAT_METADATA_MAX } from "@stll/api-contract";

import type {
  SlashItem,
  SlashSkillScope,
} from "@/components/chat/prompt-slash-extension";
import type { api } from "@/lib/api";
import type { ChatPrompt } from "@/lib/prompts/types";
import { getReservedChatCommands } from "@/lib/reserved-chat-commands";
import type { ReservedChatCommandContext } from "@/lib/reserved-chat-commands";

type SkillListResponse = Awaited<ReturnType<typeof api.skills.get>>;

/** Who wrote an installed skill's newest revision, as `skills.list` reports. */
export type SkillLastEdit = Exclude<
  NonNullable<Extract<SkillListResponse, { data: unknown }>["data"]>,
  Response
>["installed"][number]["lastEdit"];

type SlashShortcutRow = Pick<
  ChatPrompt,
  "command" | "id" | "name" | "scope"
> & {
  prompt: string;
};

type CommandShortcutRow = SlashShortcutRow & { lastEdit: SkillLastEdit };

type SlashSkillRow = {
  body?: string | null;
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

type CommandSkillPage = {
  installed: readonly (SlashSkillRow & { lastEdit: SkillLastEdit })[];
};

/**
 * Which skills a prompt input offers as chips: everything the caller can use
 * (chat, template fields) or the organization's team skills alone, for a
 * prompt whose output is shared matter data (property prompts) and so must
 * not depend on one member's private skill. Built-in skills ship with
 * Stella for every member, so the team catalog keeps them.
 */
export const SKILL_CHIP_CATALOG = {
  caller: "caller",
  team: "team",
} as const;

export type SkillChipCatalog =
  (typeof SKILL_CHIP_CATALOG)[keyof typeof SKILL_CHIP_CATALOG];

export const skillPagesForChips = (
  pages: readonly SlashSkillPage[],
  catalog: SkillChipCatalog,
): readonly SlashSkillPage[] => {
  switch (catalog) {
    case SKILL_CHIP_CATALOG.caller:
      return pages;
    case SKILL_CHIP_CATALOG.team:
      return pages.map((page) => ({
        ...page,
        installed: page.installed.filter((row) => row.scope === "team"),
      }));
    default: {
      catalog satisfies never;
      return panic(`Unhandled skill chip catalog: ${String(catalog)}`);
    }
  }
};

/**
 * Ids of the skills chat cannot offer, as the server decided them
 * (`chatUnavailableSkillsOptions`): a skill that needs a tool chat lacks is
 * never offered in a menu. `undefined` until the server has answered: no
 * skill is offered before then, so none that chat cannot finish slips in.
 */
export type UnavailableSkillIds = ReadonlySet<string> | undefined;

const isOfferedInChat = (
  skillId: string,
  unavailableSkillIds: UnavailableSkillIds,
): boolean =>
  unavailableSkillIds !== undefined && !unavailableSkillIds.has(skillId);

type BuildChatSlashItemsInput = {
  shortcuts: readonly SlashShortcutRow[];
  skillPages: readonly SlashSkillPage[] | undefined;
  unavailableSkillIds: UnavailableSkillIds;
  /**
   * Reserved-command availability context. Reserved commands only have
   * submit handling on the chat composers, so `null`/absent keeps them out
   * of other editors (workspace property prompts, template studio) that
   * reuse this builder.
   */
  reservedCommands?: ReservedChatCommandContext | null;
};

export const buildChatSlashItems = ({
  shortcuts,
  skillPages,
  unavailableSkillIds,
  reservedCommands = null,
}: BuildChatSlashItemsInput): SlashItem[] => {
  const commandItems: SlashItem[] = reservedCommands
    ? getReservedChatCommands(reservedCommands).map((command) => ({
        kind: "command" as const,
        command,
      }))
    : [];

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
  } = getChatVisibleInstalledSkillRows(skillPages, unavailableSkillIds);
  // Shadow the built-in row whenever an installed skill claims the
  // same slug, even if the installed row is omitted from the skill
  // list because it has a command. The backend `load-skill` resolves
  // by slug and would return the installed skill, so showing the
  // built-in description here would mislead the user about what the
  // slash item actually inserts.
  const firstSkillPage = skillPages?.at(0);
  const builtInSkillRows = firstSkillPage
    ? firstSkillPage.builtIn.filter(
        (row) =>
          row.enabled &&
          !enabledInstalledSlugs.has(row.slug) &&
          isOfferedInChat(row.id, unavailableSkillIds),
      )
    : [];
  const skillItems: SlashItem[] = [
    ...builtInSkillRows,
    ...installedSkillRows,
  ].map((row) => ({
    kind: "skill" as const,
    skill: {
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      scope: row.scope,
    },
  }));

  return [...commandItems, ...promptItems, ...skillItems];
};

export const commandShortcutRowsFromSkillPages = (
  skillPages: readonly CommandSkillPage[] | undefined,
  unavailableSkillIds: UnavailableSkillIds,
): CommandShortcutRow[] => {
  const rows: CommandShortcutRow[] = [];
  const installedRows = skillPages
    ? skillPages.flatMap((page) => page.installed)
    : [];

  for (const row of installedRows) {
    if (
      !row.enabled ||
      !isOfferedInChat(row.id, unavailableSkillIds) ||
      !row.command ||
      row.body === null ||
      !row.body
    ) {
      continue;
    }
    if (row.scope === "built-in") {
      continue;
    }
    rows.push({
      id: row.id,
      scope: row.scope,
      name: row.name,
      command: row.command,
      prompt: row.body,
      lastEdit: row.lastEdit,
    });
  }

  return rows;
};

const getChatVisibleInstalledSkillRows = (
  skillPages: readonly SlashSkillPage[] | undefined,
  unavailableSkillIds: UnavailableSkillIds,
): { visibleRows: SlashSkillRow[]; shadowSlugs: Set<string> } => {
  const installedRows = skillPages
    ? skillPages.flatMap((page) => page.installed)
    : [];
  const visibleRows: SlashSkillRow[] = [];
  const seenSlugs = new Set<string>();
  // Apply the chat-metadata cap to enabled installed rows before
  // building either set, so the window matches what the backend
  // `load-skill` sees: rows beyond the cap are invisible to the model,
  // so they must not shadow built-ins or appear as skill chips.
  const chatVisibleEnabled = installedRows
    .filter((row) => row.enabled)
    .toSorted(compareChatInstalledSkillRows)
    .slice(0, AGENT_SKILLS_CHAT_METADATA_MAX);
  // Every chat-visible installed slug shadows the built-in entry of
  // the same name, including ones that carry a command.
  const shadowSlugs = new Set(chatVisibleEnabled.map((row) => row.slug));
  // Command-bearing installed skills are surfaced as prompt slash
  // items by the commandSkills feed; drop them from the skill-chip
  // list so the same skill doesn't appear twice in the menu. A skill the
  // chat cannot finish is dropped after the cap, as the backend does.
  const chatMetadataRows = chatVisibleEnabled.filter(
    (row) => !row.command && isOfferedInChat(row.id, unavailableSkillIds),
  );

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
      return panic(`Unhandled scope: ${String(scope)}`);
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
