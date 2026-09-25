import { panic } from "better-result";

import { AGENT_SKILLS_CHAT_METADATA_MAX } from "@stll/api-contract";

import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import type { ChatPrompt, PromptScope } from "@/lib/prompts/types";
import { getReservedChatCommands } from "@/lib/reserved-chat-commands";
import type { ReservedChatCommandContext } from "@/lib/reserved-chat-commands";

type SlashShortcutRow = Pick<
  ChatPrompt,
  "command" | "id" | "name" | "scope"
> & {
  prompt: string;
};

type SlashSkillRow = {
  body?: string | null;
  description: string;
  enabled: boolean;
  id: string;
  name: string;
  scope: PromptScope;
  slug: string;
  /**
   * Optional slash-command handle. Installed skills with a command
   * are surfaced as prompt-style items by the parallel
   * commandSkills feed; we filter them out of the skill section so
   * the same skill doesn't render twice (once as `/command` prompt
   * insert, once as `#stella-skill-ref` skill chip).
   */
  command?: string | null;
};

type SlashSkillPage = {
  installed: readonly SlashSkillRow[];
};

type BuildChatSlashItemsInput = {
  shortcuts: readonly SlashShortcutRow[];
  skillPages: readonly SlashSkillPage[] | undefined;
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

  const skillItems: SlashItem[] = getChatVisibleInstalledSkillRows(
    skillPages,
  ).map((row) => ({
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
  skillPages: readonly SlashSkillPage[] | undefined,
): SlashShortcutRow[] => {
  const rows: SlashShortcutRow[] = [];
  const installedRows = skillPages
    ? skillPages.flatMap((page) => page.installed)
    : [];

  for (const row of installedRows) {
    if (!row.enabled || !row.command || row.body === null || !row.body) {
      continue;
    }
    rows.push({
      id: row.id,
      scope: row.scope,
      name: row.name,
      command: row.command,
      prompt: row.body,
    });
  }

  return rows;
};

const getChatVisibleInstalledSkillRows = (
  skillPages: readonly SlashSkillPage[] | undefined,
): SlashSkillRow[] => {
  const installedRows = skillPages
    ? skillPages.flatMap((page) => page.installed)
    : [];
  const visibleRows: SlashSkillRow[] = [];
  const seenSlugs = new Set<string>();
  // Apply the chat-metadata cap to enabled installed rows before
  // dropping command-bearing ones, so the window matches what the
  // backend `load-skill` sees: rows beyond the cap are invisible to
  // the model and must not appear as skill chips.
  const chatVisibleEnabled = installedRows
    .filter((row) => row.enabled)
    .toSorted(compareChatInstalledSkillRows)
    .slice(0, AGENT_SKILLS_CHAT_METADATA_MAX);
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

  return visibleRows;
};

const compareChatInstalledSkillRows = (
  left: SlashSkillRow,
  right: SlashSkillRow,
): number =>
  compareSkillScope(left.scope, right.scope) ||
  compareString(left.slug, right.slug) ||
  compareString(left.id, right.id);

const compareSkillScope = (left: PromptScope, right: PromptScope): number =>
  scopePriority(left) - scopePriority(right);

const scopePriority = (scope: PromptScope): number => {
  switch (scope) {
    case "private":
      return 0;
    case "team":
      return 1;
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
