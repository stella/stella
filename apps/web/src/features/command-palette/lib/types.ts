import type { LucideIcon } from "lucide-react";

import type { TranslationKey } from "@/i18n/types";
import type { ShortcutId } from "@/lib/hotkeys";

type CommandActionGroup = "create" | "navigate" | "view" | "workspace";

type CommandActionId =
  | "new-matter"
  | "new-chat"
  | "upload-document"
  | "new-task";

/**
 * No-argument TranslationKeys usable as command action labels, narrowed like
 * hotkeys.ts's ShortcutLabelKey so t(key) resolves to the zero-value overload
 * instead of requiring ICU arguments at the call site.
 */
type CommandActionTextKey = Extract<
  TranslationKey,
  | "common.newMatter"
  | "chat.newChat"
  | "workspaces.kanban.uploadDocument"
  | "tasks.newTask"
>;

export type CommandActionContext = {
  canCreateMatter: boolean;
  canUploadDocument: boolean;
  canCreateTask: boolean;
  openUploadDocument: () => void;
  createTask: () => void;
  openCreateMatterDialog: () => void;
  openNewChat: () => void;
};

export type CommandAction = {
  id: CommandActionId;
  group: CommandActionGroup;
  titleKey: CommandActionTextKey;
  keywords?: readonly CommandActionTextKey[];
  icon: LucideIcon;
  shortcutId?: ShortcutId;
  isAvailable: (ctx: CommandActionContext) => boolean;
  run: (ctx: CommandActionContext) => void;
};
