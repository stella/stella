import { MessageSquare, PanelLeft, PanelRight, Plus } from "lucide-react";

import { HOTKEYS } from "@/lib/hotkeys";

import type { CommandAction } from "./types";

export const COMMAND_ACTIONS: readonly CommandAction[] = [
  {
    id: "new-matter",
    group: "create",
    titleKey: "common.newMatter",
    icon: Plus,
    hotkey: HOTKEYS.NEW_MATTER,
    isAvailable: (ctx) => ctx.canCreateMatter,
    run: (ctx) => {
      ctx.openCreateMatterDialog();
    },
  },
  {
    id: "new-chat",
    group: "create",
    titleKey: "chat.newChat",
    icon: MessageSquare,
    hotkey: HOTKEYS.NEW_CHAT,
    isAvailable: (ctx) => Boolean(ctx.workspaceId),
    run: (ctx) => {
      ctx.openNewChat();
    },
  },
  {
    id: "toggle-sidebar",
    group: "view",
    titleKey: "navigation.toggleSidebar",
    icon: PanelLeft,
    hotkey: HOTKEYS.TOGGLE_SIDEBAR,
    isAvailable: () => true,
    run: (ctx) => {
      ctx.toggleSidebar();
    },
  },
  {
    id: "toggle-chat",
    group: "view",
    titleKey: "navigation.toggleChat",
    icon: PanelRight,
    hotkey: HOTKEYS.TOGGLE_CHAT,
    isAvailable: () => true,
    run: (ctx) => {
      ctx.toggleChat();
    },
  },
];
