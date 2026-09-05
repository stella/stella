import type { Hotkey } from "@tanstack/react-hotkeys";
import type { LucideIcon } from "lucide-react";

import type { TranslationKey } from "@/i18n/types";

type CommandActionGroup = "create" | "navigate" | "view" | "workspace";

type CommandActionId =
  | "new-matter"
  | "new-chat"
  | "toggle-sidebar"
  | "toggle-chat";

/**
 * No-argument TranslationKeys usable as command action labels, narrowed like
 * hotkeys.ts's ShortcutLabelKey so t(key) resolves to the zero-value overload
 * instead of requiring ICU arguments at the call site.
 */
type CommandActionTextKey = Extract<
  TranslationKey,
  | "common.newMatter"
  | "chat.newChat"
  | "navigation.toggleSidebar"
  | "navigation.toggleChat"
>;

export type CommandActionContext = {
  navigate: (opts: { to: string }) => void;
  workspaceId: string | undefined;
  canCreateMatter: boolean;
  openCreateMatterDialog: () => void;
  openNewChat: () => void;
  toggleChat: () => void;
  toggleSidebar: () => void;
};

export type CommandAction = {
  id: CommandActionId;
  group: CommandActionGroup;
  titleKey: CommandActionTextKey;
  keywords?: readonly CommandActionTextKey[];
  icon: LucideIcon;
  hotkey?: Hotkey;
  isAvailable: (ctx: CommandActionContext) => boolean;
  run: (ctx: CommandActionContext) => void;
};
