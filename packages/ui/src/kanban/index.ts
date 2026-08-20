/**
 * The kanban board: how a board's columns are resolved, what a card renders,
 * and the chrome both sit in.
 *
 * One module rather than one subpath per file, because the parts describe a
 * single contract: the schema decides the columns, the column header shows what
 * a column reduces to, and the card shell holds whatever the schema said a card
 * renders.
 */

export type { KanbanCardFieldSelection } from "./card-properties";
export { selectKanbanCardFieldIds } from "./card-properties";
export type { KanbanCardShellProps } from "./card-shell";
export { KanbanCardShell } from "./card-shell";
export type { KanbanColumnHeaderProps } from "./column-header";
export { KanbanColumnHeader } from "./column-header";
export type {
  RegisterKanbanBoardAutoScrollOptions,
  RegisterKanbanCardDragOptions,
} from "./drag-interactions";
export {
  KANBAN_BOARD_AUTO_SCROLL_SOURCES,
  registerKanbanBoardAutoScroll,
  registerKanbanCardDrag,
} from "./drag-interactions";
export type {
  KanbanBuiltInGroup,
  KanbanGroup,
  KanbanGrouping,
  KanbanGroupOption,
  KanbanSchema,
  ResolveKanbanGroupingParams,
} from "./grouping";
export {
  getKanbanGroupingPropertyId,
  getKanbanGroups,
  isKanbanGroupingRenderable,
  resolveKanbanGroupOptions,
  resolveKanbanGrouping,
  selectKanbanRows,
} from "./grouping";
