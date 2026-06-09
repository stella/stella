import type { ReactNode } from "react";

import {
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from "lucide-react";

import { cn } from "@stll/ui/lib/utils";

// Shared presentation for the file/folder tree used by the workspace Files view
// and the skills file browser, so both render an identical tree (indentation
// guides, disclosure chevron, icon, name) from one place. Data, selection, and
// behaviour live in the host; this module owns the look.

export const FILE_TREE_ROW_HEIGHT_PX = 36;
export const FILE_TREE_INDENT_PX = 20;
const DISCLOSURE_SLOT_PX = 14;
const NAME_GAP_PX = 6;
const GUIDE_COLUMN_OFFSET_PX = DISCLOSURE_SLOT_PX / 2;
const FILE_GUIDE_TARGET_OFFSET_PX = DISCLOSURE_SLOT_PX + NAME_GAP_PX;
const GUIDE_LINE_COLOR_CLASS = "bg-muted-foreground/30";

type TreeGuideLinesProps = {
  depth: number;
  guideDepths: readonly number[];
  isFolder: boolean;
  isLast: boolean;
};

/**
 * The faint vertical/elbow guide lines that connect a nested row to its
 * ancestors. `guideDepths` lists the ancestor depths that still have following
 * siblings (so their vertical line continues through this row).
 */
export const TreeGuideLines = ({
  depth,
  guideDepths,
  isFolder,
  isLast,
}: TreeGuideLinesProps) => {
  if (depth === 0) {
    return null;
  }

  const parentGuideLeft =
    (depth - 1) * FILE_TREE_INDENT_PX + GUIDE_COLUMN_OFFSET_PX;
  const folderGuideTargetLeft =
    depth * FILE_TREE_INDENT_PX + GUIDE_COLUMN_OFFSET_PX;
  const fileGuideTargetLeft =
    depth * FILE_TREE_INDENT_PX + FILE_GUIDE_TARGET_OFFSET_PX;
  const horizontalTargetLeft = isFolder
    ? folderGuideTargetLeft
    : fileGuideTargetLeft;
  const horizontalWidth = horizontalTargetLeft - parentGuideLeft;
  // The immediate parent's column is the same x as this row's own current line;
  // rendering a full-height guide there would mask the half-height "L" stop on
  // the last child.
  const continuationGuideDepths = guideDepths.filter(
    (guideDepth) => guideDepth !== depth - 1,
  );

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 start-0"
    >
      {continuationGuideDepths.map((guideDepth) => (
        <span
          className={cn(GUIDE_LINE_COLOR_CLASS, "absolute top-0 bottom-0 w-px")}
          key={guideDepth}
          style={{
            left: guideDepth * FILE_TREE_INDENT_PX + GUIDE_COLUMN_OFFSET_PX,
          }}
        />
      ))}
      <span
        className={cn(
          GUIDE_LINE_COLOR_CLASS,
          "absolute top-0 w-px",
          isLast ? "h-1/2" : "bottom-0",
        )}
        style={{ left: parentGuideLeft }}
      />
      <span
        className={cn(GUIDE_LINE_COLOR_CLASS, "absolute top-1/2 h-px")}
        style={{ left: parentGuideLeft, width: horizontalWidth }}
      />
    </span>
  );
};

type FileTreeNameCellProps = {
  depth: number;
  guideDepths: readonly number[];
  isFolder: boolean;
  isLast: boolean;
  expanded: boolean;
  icon: ReactNode;
  children: ReactNode;
};

/**
 * One row's name cell: indentation + guide lines + disclosure chevron + an icon
 * slot + the name (or an inline rename field) supplied as children. The caller
 * owns the icon and the name content so the same layout serves a workspace
 * entity (mime icon, inline rename) and a skill resource (extension icon).
 */
export const FileTreeNameCell = ({
  depth,
  guideDepths,
  isFolder,
  isLast,
  expanded,
  icon,
  children,
}: FileTreeNameCellProps) => (
  <span
    className="relative flex h-full min-w-0 items-center gap-1.5 self-stretch"
    style={{ paddingLeft: `${depth * FILE_TREE_INDENT_PX}px` }}
  >
    <TreeGuideLines
      depth={depth}
      guideDepths={guideDepths}
      isFolder={isFolder}
      isLast={isLast}
    />
    {isFolder ? (
      <ChevronRightIcon
        className={cn(
          "size-3.5 shrink-0 transition-transform",
          expanded && "rotate-90",
        )}
      />
    ) : (
      <span className="w-3.5 shrink-0" />
    )}
    {icon}
    {children}
  </span>
);

export type FileTreeNode = {
  id: string;
  name: string;
  kind: "file" | "folder";
  children?: FileTreeNode[];
};

type FlatRow = {
  node: FileTreeNode;
  depth: number;
  guideDepths: number[];
  isLast: boolean;
};

const flatten = (
  nodes: readonly FileTreeNode[],
  expandedIds: ReadonlySet<string>,
): FlatRow[] => {
  const rows: FlatRow[] = [];
  const visit = (
    siblings: readonly FileTreeNode[],
    depth: number,
    guideDepths: number[],
  ) => {
    siblings.forEach((node, index) => {
      const isLast = index === siblings.length - 1;
      rows.push({ node, depth, guideDepths, isLast });
      if (node.kind !== "folder" || !expandedIds.has(node.id)) {
        return;
      }
      visit(
        node.children ?? [],
        depth + 1,
        isLast ? guideDepths : [...guideDepths, depth],
      );
    });
  };
  visit(nodes, 0, []);
  return rows;
};

const defaultIcon = (node: FileTreeNode, expanded: boolean): ReactNode => {
  if (node.kind === "folder") {
    return expanded ? (
      <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" />
    ) : (
      <FolderIcon className="text-muted-foreground size-4 shrink-0" />
    );
  }
  return <FileIcon className="text-muted-foreground size-4 shrink-0" />;
};

export type FileTreeProps = {
  nodes: FileTreeNode[];
  expandedIds: ReadonlySet<string>;
  selectedId: string | null;
  onToggle: (id: string) => void;
  onSelect: (node: FileTreeNode) => void;
  /** Per-node icon override (e.g. mime/extension icons). Return `undefined` for a
   * node to fall back to the default folder/file icon. */
  renderIcon?: (node: FileTreeNode, expanded: boolean) => ReactNode;
  /** Name-slot override (e.g. an inline rename field). Defaults to the name. */
  renderName?: (node: FileTreeNode) => ReactNode;
  /** Trailing hover actions (rename, delete, new file…) for a row. */
  renderActions?: (node: FileTreeNode) => ReactNode;
  className?: string;
};

/**
 * A non-virtualized file/folder tree for small trees (e.g. a skill's files).
 * The workspace Files view keeps its own virtualized, drag-enabled grid but
 * shares the row presentation ({@link FileTreeNameCell}, {@link TreeGuideLines}).
 */
export function FileTree({
  nodes,
  expandedIds,
  selectedId,
  onToggle,
  onSelect,
  renderIcon,
  renderName,
  renderActions,
  className,
}: FileTreeProps) {
  const rows = flatten(nodes, expandedIds);
  return (
    <div className={cn("flex flex-col", className)}>
      {rows.map(({ node, depth, guideDepths, isLast }) => {
        const isFolder = node.kind === "folder";
        const expanded = isFolder && expandedIds.has(node.id);
        return (
          <div
            className="group/row relative flex items-center"
            key={node.id}
            style={{ height: `${FILE_TREE_ROW_HEIGHT_PX}px` }}
          >
            {/* Row is a div (not button) so a name slot can host an inline
                rename input — interactive elements can't nest inside a button. */}
            <div
              className={cn(
                "hover:bg-muted flex h-full min-w-0 flex-1 cursor-pointer items-center rounded px-2 text-start text-sm transition-colors duration-150",
                selectedId === node.id && "bg-accent",
              )}
              onClick={() => (isFolder ? onToggle(node.id) : onSelect(node))}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (isFolder) {
                    onToggle(node.id);
                  } else {
                    onSelect(node);
                  }
                }
              }}
              role="button"
              tabIndex={0}
            >
              <FileTreeNameCell
                depth={depth}
                expanded={expanded}
                guideDepths={guideDepths}
                icon={
                  renderIcon?.(node, expanded) ?? defaultIcon(node, expanded)
                }
                isFolder={isFolder}
                isLast={isLast}
              >
                {renderName ? (
                  renderName(node)
                ) : (
                  <span className="truncate" title={node.name}>
                    {node.name}
                  </span>
                )}
              </FileTreeNameCell>
            </div>
            {renderActions && (
              <span className="invisible absolute end-1 flex gap-0.5 group-hover/row:visible">
                {renderActions(node)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
