import { MessageSquare, Plus, PanelLeft, PanelRight } from "lucide-react";

import { HOTKEYS } from "@/lib/hotkeys";

import type { CommandAction } from "./types";

export const COMMAND_ACTIONS: readonly CommandAction[] = [
  {
    id: "new-matter",
    group: "create",
    titleKey: "common.newMatter",
    icon: Plus,
    hotkey: HOTKEYS.NEW_MATTER,
    isAvailable: (ctx) => Boolean(ctx.workspaceId),
    run: (ctx) => {
      ctx.navigate({ to: "/matters/new" });
    },
  },
  {
    id: "new-chat",
    group: "create",
    titleKey: "chat.newChat",
    icon: MessageSquare,
    hotkey: HOTKEYS.NEW_CHAT,
    isAvailable: () => true,
    run: (_ctx) => undefined,
  },
  {
    id: "toggle-sidebar",
    group: "view",
    titleKey: "navigation.toggleSidebar",
    icon: PanelLeft,
    hotkey: HOTKEYS.TOGGLE_SIDEBAR,
    isAvailable: () => true,
    run: (_ctx) => undefined,
  },
  {
    id: "toggle-chat",
    group: "view",
    titleKey: "chat.newChat",
    icon: PanelRight,
    hotkey: HOTKEYS.TOGGLE_CHAT,
    isAvailable: () => true,
    run: (_ctx) => undefined,
  },
];
