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

const toSelectTransportValue = (value: string) => value;

/**
 * Accessible picker shared by the board's Group and Sub-group controls. The
 * caller labels built-ins because only its domain owns their human names.
 */
export const WorkspaceKanbanGroupingPicker = <
  TRow,
  TProperty extends WorkspaceKanbanProperty<TGroupId>,
  TGroupId extends string = string,
>({
  allowNone,
  excludedGroupBy,
  getBuiltInGroupLabel,
  labels,
  onValueChange,
  schema,
  value,
}: WorkspaceKanbanGroupingPickerProps<TRow, TProperty, TGroupId>) => {
  const choices = getWorkspaceKanbanGroupingChoices({
    getBuiltInGroupLabel,
    schema,
  }).filter(({ id }) => id !== excludedGroupBy);
  const selected = choices.find((choice) => choice.id === value);
  const display =
    selected?.label ?? (allowNone ? labels.none : labels.placeholder);
  const selectedValue = toSelectTransportValue(value);

  return (
    <Select
      onValueChange={(nextValue) => {
        if (nextValue === null) {
          return;
        }
        if (nextValue === NO_GROUPING_VALUE) {
          onValueChange(NO_GROUPING_VALUE);
          return;
        }
        const nextChoice = choices.find(({ id }) => id === nextValue);
        if (nextChoice !== undefined) {
          onValueChange(nextChoice.id);
        }
      }}
      value={selectedValue}
    >
      <SelectTrigger aria-label={labels.control} size="sm">
        <SelectValue placeholder={labels.placeholder}>{display}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {allowNone ? (
          <SelectItem value={NO_GROUPING_VALUE}>{labels.none}</SelectItem>
        ) : null}
        {choices.map((choice) => (
          <SelectItem key={choice.id} value={toSelectTransportValue(choice.id)}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};
