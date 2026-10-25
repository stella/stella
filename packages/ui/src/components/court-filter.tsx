"use client";

import { useId, useState } from "react";

import { ChevronRightIcon } from "../icons";
import { cn } from "../lib/utils";
import { BidiText } from "./bidi-text";
import { Checkbox } from "./checkbox";
import { DirectionalIcon } from "./directional-icon";
import { Field, FieldLabel } from "./field";
import { ScrollArea } from "./scroll-area";
import { SearchField } from "./search-field";

type CourtOption = { value: string; label?: string; badgeText?: string };
type CourtFilterGroup = {
  value: string;
  label: string | null;
  courts: readonly CourtOption[];
};
type CourtFilterProps = {
  groups: readonly CourtFilterGroup[];
  label: string;
} & (
  | {
      mode: "single";
      selected: string | undefined;
      onChange: (value: string | undefined) => void;
      collapsedGroups: readonly string[];
      visibleRowLimit: number;
      showAllLabel: string;
    }
  | {
      mode: "multiple";
      selected: readonly string[];
      onChange: (values: string[]) => void;
      maxSelections: number;
      selectionHint: string;
      searchLabel: string;
      clearLabel: string;
      emptyLabel: string;
      matchText: (value: string) => string;
    }
);

export const toggleCourtSelection = (
  selected: readonly string[],
  values: readonly string[],
) => {
  const remove = values.every((value) => selected.includes(value));
  return remove
    ? selected.filter((value) => !values.includes(value))
    : [...new Set([...selected, ...values])];
};

type SingleCourtGroupProps = {
  group: CourtFilterGroup;
  options: Extract<CourtFilterProps, { mode: "single" }>;
};
const SingleCourtGroup = ({ group, options }: SingleCourtGroupProps) => {
  const panelId = useId();
  const [open, setOpen] = useState(
    !options.collapsedGroups.includes(group.value),
  );
  const [showAll, setShowAll] = useState(false);
  const selectedHere = group.courts.find(
    ({ value }) => value === options.selected,
  );
  const expanded = open || selectedHere !== undefined;
  const items = showAll
    ? [...group.courts]
    : group.courts.slice(0, options.visibleRowLimit);
  if (selectedHere !== undefined && !items.includes(selectedHere)) {
    items.push(selectedHere);
  }
  const hiddenCount = group.courts.length - items.length;
  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      {group.label !== null && (
        <button
          type="button"
          aria-controls={panelId}
          aria-expanded={expanded}
          className="text-foreground-strong-muted hover:text-foreground flex min-h-11 w-full items-center gap-1 py-1 text-start text-xs font-medium"
          onClick={() => setOpen(!expanded)}
        >
          <DirectionalIcon
            className={cn(
              "size-3 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
            flip={!expanded}
            icon={ChevronRightIcon}
          />
          {group.label}
        </button>
      )}
      <div hidden={group.label !== null && !expanded} id={panelId}>
        <ul aria-label={group.label ?? options.label} className="flex flex-col">
          {items.map(({ value, label, badgeText }) => {
            const checked = options.selected === value;
            return (
              <li key={value}>
                <label className="hover:bg-muted/60 has-[:focus-visible]:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-sm py-1.5 ps-1 pe-1 text-xs has-[:focus-visible]:ring-2">
                  <input
                    type="radio"
                    name={`court-${panelId}`}
                    value={value}
                    checked={checked}
                    className="accent-primary size-3.5 shrink-0"
                    onChange={() => options.onChange(value)}
                    onClick={() => {
                      if (checked) {
                        options.onChange(undefined);
                      }
                    }}
                  />
                  <BidiText
                    as="span"
                    className={cn(
                      "text-foreground min-w-0 flex-1 truncate",
                      checked && "font-medium",
                    )}
                    title={label ?? value}
                  >
                    {label ?? value}
                  </BidiText>
                  {badgeText !== undefined && (
                    <bdi className="text-muted-foreground text-2xs shrink-0 tabular-nums">
                      {badgeText}
                    </bdi>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        {hiddenCount > 0 && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground -mx-1 min-h-11 px-1 py-1.5 text-xs"
            onClick={() => setShowAll(true)}
          >
            {options.showAllLabel}
          </button>
        )}
      </div>
    </div>
  );
};

type MultipleCourtGroupProps = {
  group: CourtFilterGroup;
  courts: readonly CourtOption[];
  options: Extract<CourtFilterProps, { mode: "multiple" }>;
  hintId: string;
};
const MultipleCourtGroup = ({
  group,
  courts,
  options,
  hintId,
}: MultipleCourtGroupProps) => {
  const labelId = useId();
  const { selected } = options;
  const values = courts.map(({ value }) => value);
  const tierSelected = values.every((value) => selected.includes(value));
  const nextTier = toggleCourtSelection(selected, values);
  const tierDisabled = !tierSelected && nextTier.length > options.maxSelections;
  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{group.label ?? options.label}</legend>
      {group.label !== null && (
        <label
          id={`${labelId}-tier`}
          className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium"
        >
          <Checkbox
            aria-labelledby={`${labelId}-tier`}
            checked={tierSelected}
            indeterminate={
              !tierSelected && values.some((value) => selected.includes(value))
            }
            disabled={tierDisabled}
            aria-describedby={hintId}
            onCheckedChange={() => {
              if (tierSelected || nextTier.length <= options.maxSelections) {
                options.onChange(nextTier);
              }
            }}
          />
          {group.label}
        </label>
      )}
      <ul className="flex flex-col">
        {courts.map(({ value, label, badgeText }, index) => {
          const checked = selected.includes(value);
          const next = toggleCourtSelection(selected, [value]);
          return (
            <li key={value}>
              <label
                id={`${labelId}-${index}`}
                className="hover:bg-muted/60 has-[:focus-visible]:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-sm text-sm has-[:focus-visible]:ring-2"
              >
                <Checkbox
                  aria-labelledby={`${labelId}-${index}`}
                  checked={checked}
                  disabled={!checked && next.length > options.maxSelections}
                  aria-describedby={hintId}
                  onCheckedChange={() => {
                    if (checked || next.length <= options.maxSelections) {
                      options.onChange(next);
                    }
                  }}
                />
                <bdi className="min-w-0 flex-1 wrap-break-word">
                  {label ?? value}
                </bdi>
                {badgeText !== undefined && (
                  <bdi className="text-muted-foreground text-xs tabular-nums">
                    {badgeText}
                  </bdi>
                )}
              </label>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
};

const MultipleCourtFilter = (
  options: Extract<CourtFilterProps, { mode: "multiple" }>,
) => {
  const [query, setQuery] = useState("");
  const hintId = useId();
  const needle = options.matchText(query);
  const missing = options.selected.filter(
    (name) =>
      !options.groups.some((group) =>
        group.courts.some(({ value }) => value === name),
      ),
  );
  const groups = [...options.groups];
  if (missing.length > 0) {
    groups.push({
      value: "selected",
      label: null,
      courts: missing.map((value) => ({ value })),
    });
  }
  const visible = groups.flatMap((group) => {
    const courts = options.matchText(group.label ?? "").includes(needle)
      ? group.courts
      : group.courts.filter(({ value, label }) =>
          options.matchText(label ?? value).includes(needle),
        );
    return courts.length === 0 ? [] : [{ group, courts }];
  });
  return (
    <div className="min-w-0 space-y-2">
      <Field>
        <FieldLabel className="sr-only">{options.searchLabel}</FieldLabel>
        <SearchField
          value={query}
          onValueChange={setQuery}
          clearLabel={options.clearLabel}
          placeholder={options.searchLabel}
        />
      </Field>
      <p id={hintId} role="status" className="text-muted-foreground text-xs">
        {options.selectionHint}
      </p>
      <ScrollArea className="h-72" axis="vertical" aria-label={options.label}>
        <div className="space-y-2">
          {visible.length === 0 && (
            <p className="text-muted-foreground py-2 text-sm">
              {options.emptyLabel}
            </p>
          )}
          {visible.map(({ group, courts }) => (
            <MultipleCourtGroup
              key={group.value}
              group={group}
              courts={courts}
              options={options}
              hintId={hintId}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

/** Court filtering shares an owner while each surface keeps its interaction model. */
export const CourtFilter = (props: CourtFilterProps) => {
  if (props.mode === "multiple") {
    return <MultipleCourtFilter {...props} />;
  }
  return (
    <div className="flex flex-col gap-3">
      {props.groups.map((group) => (
        <SingleCourtGroup key={group.value} group={group} options={props} />
      ))}
    </div>
  );
};
