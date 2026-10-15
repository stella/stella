import type { LucideIcon } from "@stll/ui/icons";

import type { TranslationKey } from "@/i18n/types";
import type { ShortcutId } from "@/lib/hotkeys";
import type { Capability } from "@/lib/organization/feature-access/action-capabilities.logic";

type CommandActionGroup = "create" | "navigate" | "view" | "workspace";

type CommandActionId =
  | "new-matter"
  | "new-chat"
  | "upload-document"
  | "new-task"
  | "log-time";

/**
 * No-argument TranslationKeys usable as command action labels, narrowed like
 * hotkeys.ts's ShortcutLabelKey so t(key) resolves to the zero-value overload
 * instead of requiring ICU arguments at the call site.
 */
type CommandActionTextKey = Extract<
  TranslationKey,
  | "common.newMatter"
  | "common.logTime"
  | "chat.newChat"
  | "workspaces.kanban.uploadDocument"
  | "tasks.newTask"
>;

export type CommandActionContext = {
  canCreateMatter: boolean;
  canLogTime: boolean;
  canUploadDocument: boolean;
  canCreateTask: boolean;
  openUploadDocument: () => void;
  createTask: () => void;
  openCreateMatterDialog: () => void;
  openNewChat: () => void;
  openLogTime: () => void;
};

export type CommandAction = {
  capability: Capability | null;
  id: CommandActionId;
  group: CommandActionGroup;
  titleKey: CommandActionTextKey;
  keywords?: readonly CommandActionTextKey[];
  icon: LucideIcon;
  shortcutId?: ShortcutId;
  isAvailable: (ctx: CommandActionContext) => boolean;
  run: (ctx: CommandActionContext) => void;
};
