import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import {
  getWorkspaceKanbanGroupingChoices,
  type WorkspaceKanbanGroupingPickerProps,
  type WorkspaceKanbanProperty,
} from "./kanban-view";

const NO_GROUPING_VALUE = "";

/**
 * Accessible picker shared by the board's Group and Sub-group controls. The
 * caller labels built-ins because only its domain owns their human names.
 */
export const WorkspaceKanbanGroupingPicker = <
  TRow,
  TProperty extends WorkspaceKanbanProperty,
>({
  allowNone,
  excludedGroupBy,
  getBuiltInGroupLabel,
  labels,
  onValueChange,
  schema,
  value,
}: WorkspaceKanbanGroupingPickerProps<TRow, TProperty>) => {
  const choices = getWorkspaceKanbanGroupingChoices({
    getBuiltInGroupLabel,
    schema,
  }).filter(({ id }) => id !== excludedGroupBy);
  const selected = choices.find((choice) => choice.id === value);
  const display =
    selected?.label ?? (allowNone ? labels.none : labels.placeholder);

  return (
    <Select
      onValueChange={(nextValue) => {
        if (nextValue === null) {
          return;
        }
        onValueChange(nextValue);
      }}
      value={value}
    >
      <SelectTrigger size="sm">
        <SelectValue placeholder={labels.placeholder}>{display}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {allowNone ? (
          <SelectItem value={NO_GROUPING_VALUE}>{labels.none}</SelectItem>
        ) : null}
        {choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};
