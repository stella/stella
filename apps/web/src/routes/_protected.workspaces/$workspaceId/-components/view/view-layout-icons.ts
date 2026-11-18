import type { ElementType } from "react";

import {
  CalendarIcon,
  FileCheckIcon,
  FolderTreeIcon,
  GanttChartIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  MailIcon,
  TableIcon,
} from "@stll/ui/icons";

import type { ViewLayoutType } from "@/lib/api-contract";

/** The icon a view's tab and the layout menus show for each layout. */
export const VIEW_LAYOUT_ICONS = {
  overview: LayoutDashboardIcon,
  table: TableIcon,
  filesystem: FolderTreeIcon,
  kanban: KanbanIcon,
  calendar: CalendarIcon,
  timeline: GanttChartIcon,
  avt: FileCheckIcon,
  correspondence: MailIcon,
} as const satisfies Record<ViewLayoutType, ElementType>;
