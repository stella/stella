import { Skeleton } from "@stll/ui/skeleton";

const CORRESPONDENCE_SKELETON_ROWS = 5;

/** The message list while it loads. */
export const CorrespondenceListSkeleton = () => (
  <div className="space-y-2">
    {Array.from(
      { length: CORRESPONDENCE_SKELETON_ROWS },
      (_, row) => `row-${row}`,
    ).map((rowKey) => (
      <div
        className="flex h-16 items-center gap-4 rounded-lg border px-4"
        key={rowKey}
      >
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-56" />
          <Skeleton className="h-3 w-36" />
        </div>
        <Skeleton className="h-3 w-20" />
      </div>
    ))}
  </div>
);

/** The correspondence view while it loads: the address card, the drop area and the list. */
export const CorrespondenceViewSkeleton = () => (
  <div className="space-y-5 p-4 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-9 w-24 rounded-md" />
    </div>
    <Skeleton className="h-11 w-full rounded-md" />
    <CorrespondenceListSkeleton />
  </div>
);
