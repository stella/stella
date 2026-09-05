import { MessageSquare, Plus, Upload, SquareCheck } from "lucide-react";

import type { CommandAction } from "./types";

export const COMMAND_ACTIONS: readonly CommandAction[] = [
  {
    id: "new-matter",
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
    group: "create",
    titleKey: "tasks.newTask",
    icon: SquareCheck,
    isAvailable: (ctx) => ctx.canCreateTask,
    run: (ctx) => {
      ctx.createTask();
    },
  },
];
