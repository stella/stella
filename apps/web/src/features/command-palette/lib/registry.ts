import {
  ClockIcon as Clock,
  MessageSquareIcon as MessageSquare,
  PlusIcon as Plus,
  UploadIcon as Upload,
  SquareCheckIcon as SquareCheck,
} from "@stll/ui/icons";

import type { CommandAction } from "./types";

export const COMMAND_ACTIONS: readonly CommandAction[] = [
  {
    id: "log-time",
    capability: null,
    group: "create",
    titleKey: "common.logTime",
    icon: Clock,
    shortcutId: "logTime",
    isAvailable: (ctx) => ctx.canLogTime,
    run: (ctx) => {
      ctx.openLogTime();
    },
  },
  {
    id: "new-matter",
    capability: null,
    group: "create",
    titleKey: "common.newMatter",
    icon: Plus,
    shortcutId: "newMatter",
    isAvailable: (ctx) => ctx.canCreateMatter,
    run: (ctx) => {
      ctx.openCreateMatterDialog();
    },
  },
  {
    id: "new-chat",
    capability: "ai",
    group: "create",
    titleKey: "chat.newChat",
    icon: MessageSquare,
    shortcutId: "newChat",
    isAvailable: () => true,
    run: (ctx) => {
      ctx.openNewChat();
    },
  },
  {
    id: "upload-document",
    capability: null,
    group: "create",
    titleKey: "workspaces.kanban.uploadDocument",
    icon: Upload,
    isAvailable: (ctx) => ctx.canUploadDocument,
    run: (ctx) => {
      ctx.openUploadDocument();
    },
  },
  {
    id: "new-task",
    capability: null,
    group: "create",
    titleKey: "tasks.newTask",
    icon: SquareCheck,
    isAvailable: (ctx) => ctx.canCreateTask,
    run: (ctx) => {
      ctx.createTask();
    },
  },
];
