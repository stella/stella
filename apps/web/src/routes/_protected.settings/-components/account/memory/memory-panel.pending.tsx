import {
  ButtonFace,
  FaceLabelPending,
  FieldTriggerFace,
  InputFace,
  TabsFace,
} from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";
import { MemoryRowSkeleton } from "@/routes/_protected.settings/-components/account/memory/memory-row.pending";

/*
 * The memory panel's pieces in a pending phase (`MemoryPanel`): the tab
 * strip, the composer and the list, at the live panel's geometry. The list's
 * placeholder also stands in while a tab's list loads inside the live panel.
 */

/** The panel's tabs in order, by label; "Mine" opens first. */
export const MEMORY_TABS = [
  { key: "mine", labelKey: "memory.tabs.mine" },
  { key: "firm", labelKey: "memory.tabs.firm" },
  { key: "matter", labelKey: "memory.tabs.matter" },
] as const;

/** A tab's content column under the strip. */
export const MEMORY_TAB_CONTENT_CLASS = "flex flex-col gap-6 pt-4";

/** The list's column: the view filter over the cards. */
export const MEMORY_LIST_CLASS = "flex flex-col gap-3";

/** The cards' column. */
export const MEMORY_CARDS_CLASS = "flex flex-col gap-2";

/** The kind picker's width in the composer. */
const MEMORY_KIND_TRIGGER_CLASS = "w-44 shrink-0";

const MEMORY_ROWS_PENDING = [{ key: "a" }, { key: "b" }, { key: "c" }] as const;

/** The cards while a list loads. */
export const MemoryCardsPending = () => (
  <div className={MEMORY_CARDS_CLASS}>
    {MEMORY_ROWS_PENDING.map((row, index) => (
      <MemoryRowSkeleton index={index} key={row.key} />
    ))}
  </div>
);

/** The composer's face: the kind picker, the text box, the add button. */
const MemoryCreateFormPending = () => (
  <div aria-hidden="true" className="flex w-full flex-col gap-2">
    <div className="flex items-start gap-2">
      <FieldTriggerFace className={MEMORY_KIND_TRIGGER_CLASS}>
        <FaceLabelPending className="w-20" />
      </FieldTriggerFace>
      <InputFace className="min-h-16.5 max-sm:min-h-19.5" />
    </div>
    <ButtonFace className="self-start" size="sm" variant="default">
      <PendingText barClassName="w-8" id="common.add" />
    </ButtonFace>
  </div>
);

/** The view filter's faces: the active view, then the other two. */
const MemoryViewFilterPending = () => (
  <div aria-hidden="true" className="flex gap-2">
    <ButtonFace size="sm" variant="secondary">
      <PendingText barClassName="w-10" id="common.active" />
    </ButtonFace>
    <ButtonFace size="sm" variant="ghost">
      <PendingText barClassName="w-10" id="common.stale" />
    </ButtonFace>
    <ButtonFace size="sm" variant="ghost">
      <PendingText barClassName="w-14" id="memory.views.archived" />
    </ButtonFace>
  </div>
);

/** The panel in its pending phase, on its first tab. */
export const MemoryPanelPending = () => (
  <div className="flex flex-col gap-2">
    <TabsFace
      tabs={MEMORY_TABS.map((tab) => ({
        key: tab.key,
        label: <PendingText barClassName="w-12" id={tab.labelKey} />,
      }))}
    />
    <div className="flex-1">
      <div className={MEMORY_TAB_CONTENT_CLASS}>
        <MemoryCreateFormPending />
        <div className={MEMORY_LIST_CLASS}>
          <MemoryViewFilterPending />
          <MemoryCardsPending />
        </div>
      </div>
    </div>
  </div>
);
