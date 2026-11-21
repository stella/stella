import { FaceLabelPending } from "@stll/ui/control-face";
import { Skeleton } from "@stll/ui/skeleton";

// The file tree's row geometry, shared by `FileTree` and its pending rows
// (a pending-safe module).

/** One tree row's height. */
export const FILE_TREE_ROW_HEIGHT_PX = 36;

/**
 * A top-level file row before the tree is read, in `FileTree`'s row box: the
 * disclosure slot, the icon and the name, each on its own place.
 */
export const FileTreeRowPending = ({
  nameClassName = "w-24",
}: {
  nameClassName?: string | undefined;
}) => (
  <div
    aria-hidden="true"
    className="flex items-center rounded-sm px-2 text-sm"
    data-slot="file-tree-row-pending"
    style={{ height: `${FILE_TREE_ROW_HEIGHT_PX}px` }}
  >
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="w-3.5 shrink-0" />
      <Skeleton className="size-4 shrink-0 rounded-sm" />
      <FaceLabelPending className={nameClassName} />
    </span>
  </div>
);
