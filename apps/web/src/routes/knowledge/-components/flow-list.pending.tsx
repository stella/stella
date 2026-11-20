import type { ReactNode } from "react";

import { ButtonFace, SwitchFace } from "@stll/ui/control-face";
import { PlusIcon, RotateCcwIcon, WorkflowIcon } from "@stll/ui/icons";
import { InlineSkeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

/*
 * The workflows list's shape (./flow-list.tsx): its column, toolbar and
 * rows, with no behaviour, so its loading view draws the page it stands in
 * for before any provider mounts.
 */

export const FLOW_LIST_CLASS = "flex min-h-0 flex-1 flex-col";

/** The bar above the list; the refresh and create actions sit at its end. */
export const FlowListToolbar = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center justify-end gap-1 border-b px-4 py-2">
    {children}
  </div>
);

/** A workflow row's box; the row's open button and its switch sit in it. */
export const FLOW_ROW_CLASS = "flex items-center gap-3 px-4 py-3";

/** What a workflow row shows: its tile, its name and the line under it. */
export const FlowRowBody = ({
  meta,
  title,
}: {
  meta: ReactNode;
  title: ReactNode;
}) => (
  <span className="flex min-w-0 flex-1 items-center gap-3">
    <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      <WorkflowIcon className="text-muted-foreground size-4" />
    </span>
    <span className="flex min-w-0 flex-1 flex-col">
      {title}
      <span className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
        {meta}
      </span>
    </span>
  </span>
);

const ROW_KEYS = ["a", "b", "c", "d", "e"];
const TITLE_WIDTHS = ["w-48", "w-40", "w-56", "w-36", "w-44"];

/** Workflow rows while the list loads: each line a bar at its height, the
 *  trigger badge's box, and the switch off. */
const FlowRowsPending = () => (
  <ul aria-hidden="true" className="divide-y">
    {ROW_KEYS.map((key, index) => (
      <li className={FLOW_ROW_CLASS} key={key}>
        <FlowRowBody
          meta={
            // The trigger badge's box (`FlowTriggerBadge`), its label a bar.
            <span className="inline-flex items-center rounded-md border px-2 py-0.5">
              <InlineSkeleton className="my-0.5 h-3 w-14" />
            </span>
          }
          title={
            <span className="flex h-5 items-center text-sm">
              <InlineSkeleton
                className={cn("h-3.5 max-w-full", TITLE_WIDTHS[index])}
              />
            </span>
          }
        />
        <SwitchFace />
      </li>
    ))}
  </ul>
);

/** The workflows page before its list arrives: the toolbar a member's role
 *  gets, and placeholder rows. */
export const FlowListPending = ({ canCreate }: { canCreate: boolean }) => (
  <div className={FLOW_LIST_CLASS}>
    <FlowListToolbar>
      <ButtonFace size="icon-sm" variant="ghost">
        <RotateCcwIcon />
      </ButtonFace>
      {canCreate && (
        <ButtonFace size="sm" variant="default">
          <PlusIcon />
          <span className="hidden sm:inline">
            <PendingText barClassName="w-20" id="flows.createFlow" />
          </span>
        </ButtonFace>
      )}
    </FlowListToolbar>
    <div className="flex-1 overflow-hidden">
      <FlowRowsPending />
    </div>
  </div>
);
