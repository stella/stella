import type { MyWorkItem } from "@/lib/workspaces/queries/my-work";

type WorkItemDates = Pick<
  MyWorkItem,
  "attention" | "hardDeadlineDate" | "workingTargetDate"
>;

export const getDisplayedWorkDate = ({
  attention,
  hardDeadlineDate,
  workingTargetDate,
}: WorkItemDates) => {
  if (attention === "hard_deadline_due") {
    return hardDeadlineDate;
  }
  if (attention === "working_target_due") {
    return workingTargetDate;
  }
  return hardDeadlineDate ?? workingTargetDate;
};
