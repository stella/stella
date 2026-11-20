import type { ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  SwitchFace,
} from "@stll/ui/control-face";
import { PlusIcon, RotateCcwIcon, WorkflowIcon } from "@stll/ui/icons";

import {
  ActionFace,
  KnowledgeRowBody,
  KnowledgeRowsPending,
  RowTitlePending,
} from "@/features/knowledge/views/knowledge-list.pending";

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
  <KnowledgeRowBody
    icon={WorkflowIcon}
    meta={meta}
    metaClassName="mt-0.5 flex items-center gap-2"
    title={title}
  />
);

/** The workflows page before its list arrives: the toolbar a member's role
 *  gets, and placeholder rows (each line a bar at its height, the trigger
 *  badge's box, and the switch off). */
export const FlowListPending = ({ canCreate }: { canCreate: boolean }) => (
  <div className={FLOW_LIST_CLASS}>
    <FlowListToolbar>
      <ButtonFace size="icon-sm" variant="ghost">
        <RotateCcwIcon />
      </ButtonFace>
      {canCreate && (
        <ActionFace
          icon={<PlusIcon />}
          label="flows.createFlow"
          labelFromSm
          variant="default"
          width="w-20"
        />
      )}
    </FlowListToolbar>
    <div className="flex-1 overflow-hidden">
      <KnowledgeRowsPending
        count={5}
        row={(index) => (
          <li className={FLOW_ROW_CLASS} key={index}>
            <FlowRowBody
              meta={
                // The trigger badge's box (`FlowTriggerBadge`).
                <span className="inline-flex rounded-md border px-2 py-0.5">
                  <FaceLabelPending className="w-14" />
                </span>
              }
              title={<RowTitlePending index={index} />}
            />
            <SwitchFace />
          </li>
        )}
      />
    </div>
  </div>
);
