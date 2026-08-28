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
  KanbanDragHandleProps,
  KanbanSortableBindings,
  KanbanSortableBoardProps,
  KanbanSortableColumnsProps,
  KanbanSortableListProps,
  UseKanbanSortableOptions,
} from "./sortable-interactions";
export {
  KANBAN_MOUSE_ACTIVATION_DISTANCE,
  KANBAN_TOUCH_ACTIVATION_CONSTRAINT,
  KanbanDragHandle,
  KanbanSortableBoard,
  KanbanSortableColumns,
  KanbanSortableList,
  useKanbanSortable,
  useKanbanSortableSensors,
} from "./sortable-interactions";
export type { KanbanDirection, KanbanHorizontalEdge } from "./sortable-edge";
export {
  getKanbanHorizontalEdge,
  KANBAN_DIRECTIONS,
  KANBAN_HORIZONTAL_EDGES,
} from "./sortable-edge";
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
export type {
  BuildKanbanBoardMatrixParams,
  CreateKanbanDropIntentParams,
  KanbanBoardAxis,
  KanbanBoardCell,
  KanbanBoardCoordinate,
  KanbanBoardLane,
  KanbanBoardMatrix,
  KanbanDropAxisChange,
  KanbanDropIntent,
  OrderKanbanCellsByColumnsParams,
  ResolveKanbanGroupValueParams,
} from "./matrix";
export {
  buildKanbanBoardMatrix,
  createKanbanDropIntent,
  KANBAN_BOARD_AXES,
  orderKanbanCellsByColumns,
} from "./matrix";
export type {
  KanbanSubgroupBoardProps,
  KanbanSubgroupCellContext,
  KanbanSubgroupColumnHeaderContext,
  KanbanSubgroupLaneIdentityContext,
} from "./subgroup-board";
export { KanbanSubgroupBoard } from "./subgroup-board";
export type {
  KanbanVirtualCellPagination,
  KanbanVirtualCellProps,
} from "./virtual-cell";
export {
  KANBAN_VIRTUAL_CELL_PAGINATION,
  KanbanVirtualCell,
} from "./virtual-cell";
