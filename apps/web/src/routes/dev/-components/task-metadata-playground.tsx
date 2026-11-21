import type { ComponentProps } from "react";

import {
  ItemTypeSelect,
  MetadataRow,
  PrioritySelect,
  StatusSelect,
  WorkTypeSelect,
} from "@/components/workspaces/tasks/task-metadata";

const STATUS = {
  value: "open",
  onChange: () => undefined,
} satisfies ComponentProps<typeof StatusSelect>;
const PRIORITY = {
  value: "none",
  onChange: () => undefined,
} satisfies ComponentProps<typeof PrioritySelect>;
const WORK_TYPE = {
  value: "task",
  onChange: () => undefined,
} satisfies ComponentProps<typeof WorkTypeSelect>;
const ITEM_TYPE = {
  ariaLabel: "Item type",
  value: "task",
  onChange: () => undefined,
} satisfies ComponentProps<typeof ItemTypeSelect>;

export const TaskMetadataPlayground = () => (
  <div
    className="mx-auto w-full max-w-md space-y-3 p-4"
    data-playground-section="task-metadata"
  >
    <MetadataRow label="Status">
      <StatusSelect {...STATUS} />
    </MetadataRow>
    <MetadataRow label="Priority">
      <PrioritySelect {...PRIORITY} />
    </MetadataRow>
    <MetadataRow label="Work type">
      <WorkTypeSelect {...WORK_TYPE} />
    </MetadataRow>
    <MetadataRow label="Item type">
      <ItemTypeSelect {...ITEM_TYPE} />
    </MetadataRow>
  </div>
);
