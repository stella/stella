import type { Hotkey } from "@tanstack/react-hotkeys";
import type { LucideIcon } from "lucide-react";

import type { TranslationKey } from "@/i18n/types";

export type CommandActionGroup = "create" | "navigate" | "view" | "workspace";

export type CommandActionId =
  | "new-matter"
  | "new-chat"
  | "toggle-sidebar"
  | "toggle-chat";

export type CommandActionContext = {
  navigate: (opts: { to: string }) => void;
  workspaceId?: string | undefined;
};

export type CommandAction = {
  id: CommandActionId;
  group: CommandActionGroup;
  titleKey: TranslationKey;
  keywords?: readonly TranslationKey[];
  icon: LucideIcon;
  hotkey?: Hotkey;
  isAvailable: (ctx: CommandActionContext) => boolean;
  run: (ctx: CommandActionContext) => void;
};
