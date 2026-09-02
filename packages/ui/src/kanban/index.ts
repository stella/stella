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
export type { KanbanCellActionProps } from "./cell-action";
export { KanbanCellAction } from "./cell-action";
export type {
  KanbanBandToggleActivation,
  KanbanColumnBandHeaderProps,
} from "./column-band-header";
export { KanbanColumnBandHeader } from "./column-band-header";
export type { KanbanColumnBandSpan } from "./column-bands";
export {
  hasKanbanColumnBands,
  KANBAN_COLLAPSED_BAND_WIDTH_CLASS,
  KANBAN_COLLAPSED_BAND_WIDTH_PX,
  KANBAN_COLUMN_GAP_PX,
  KANBAN_COLUMN_WIDTH_CLASS,
  KANBAN_COLUMN_WIDTH_PX,
  resolveKanbanColumnBands,
} from "./column-bands";
export type { KanbanColumnHeaderProps } from "./column-header";
export { KanbanColumnHeader } from "./column-header";
export type {
  KanbanCardDragSurfaceProps,
  KanbanDragHandleProps,
  KanbanDragCancelEvent,
  KanbanDragEndEvent,
  KanbanDragOverEvent,
  KanbanDragStartEvent,
  KanbanSortableActivationMode,
  KanbanSortableBindings,
  KanbanSortableBoardProps,
  KanbanSortableColumnsProps,
  KanbanSortableListProps,
  KanbanVirtualScrollRequest,
  KanbanCellVirtualNavigation,
  UseKanbanSortableOptions,
  UseKanbanDropTargetOptions,
} from "./sortable-interactions";
export {
  KANBAN_BOARD_AUTO_SCROLL_OPTIONS,
  KANBAN_MOUSE_ACTIVATION_DISTANCE,
  KANBAN_BOARD_COLLISION_DETECTION,
  KANBAN_DRAG_OVERLAY_Z_INDEX,
  KANBAN_SORTABLE_ACTIVATION_MODES,
  KANBAN_TOUCH_ACTIVATION_CONSTRAINT,
  KanbanCardDragSurface,
  KanbanDragHandle,
  KanbanSortableBoard,
  KanbanSortableColumns,
  KanbanSortableList,
  useKanbanSortable,
  useKanbanDropTarget,
  useKanbanSortableSensors,
  kanbanKeyboardCoordinates,
} from "./sortable-interactions";
export type { KanbanSortableCellPosition } from "./sortable-interactions";
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
  KanbanColumnBand,
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
  KanbanBoardDestination,
  KanbanBoardColumn,
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
  getKanbanBoardColumnIdentity,
  getKanbanBoardLaneIdentity,
  KANBAN_BOARD_AXES,
  orderKanbanCellsByColumns,
} from "./matrix";
export type {
  KanbanSubgroupBandHeaderContext,
  KanbanSubgroupBoardProps,
  KanbanSubgroupCellContext,
  KanbanSubgroupCollapsedBandCellContext,
  KanbanSubgroupColumnHeaderContext,
  KanbanSubgroupLaneIdentityContext,
} from "./subgroup-board";
export {
  KANBAN_BAND_PEEK_DELAY_MS,
  KANBAN_BAND_PEEK_LINGER_MS,
} from "./band-peek";
export { KanbanSubgroupBoard } from "./subgroup-board";
export type {
  KanbanVirtualCellPagination,
  KanbanVirtualCellProps,
  KanbanVirtualCellSortableContext,
} from "./virtual-cell";
export {
  KANBAN_VIRTUAL_CELL_PAGINATION,
  KanbanVirtualCell,
} from "./virtual-cell";
