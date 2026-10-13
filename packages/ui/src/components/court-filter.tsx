"use client";

import { useId, useState } from "react";

import { Checkbox } from "./checkbox";
import { ScrollArea } from "./scroll-area";
import { SearchField } from "./search-field";

type CourtFilterGroup = {
  value: string;
  label: string;
  courts: readonly { value: string; label?: string; badgeText?: string }[];
};
type CourtFilterProps = {
  groups: readonly CourtFilterGroup[];
  label: string;
  searchLabel: string;
  clearLabel: string;
  emptyLabel: string;
  matchText: (value: string) => string;
} & (
  | {
      mode: "single";
      selected: string | undefined;
      onChange: (value: string | undefined) => void;
    }
  | {
      mode: "multiple";
      selected: readonly string[];
      onChange: (values: string[]) => void;
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

/** Court rows share one owner across the web index and embedded search apps. */
export const CourtFilter = (props: CourtFilterProps) => {
  const [query, setQuery] = useState("");
  const radioName = useId();
  const needle = props.matchText(query);
  const selected = (() => {
    if (props.mode === "multiple") {
      return props.selected;
    }
    return props.selected === undefined ? [] : [props.selected];
  })();
  const missing = selected.filter(
    (name) =>
      !props.groups.some((group) =>
        group.courts.some(({ value }) => value === name),
      ),
  );
  const groups =
    missing.length === 0
      ? props.groups
      : [
          ...props.groups,
          {
            value: "selected",
            label: props.label,
            courts: missing.map((value) => ({ value })),
          },
        ];
  const visible = groups.flatMap((group) => {
    const courts = props.matchText(group.label).includes(needle)
      ? group.courts
      : group.courts.filter(({ value, label }) =>
          props.matchText(label ?? value).includes(needle),
        );
    return courts.length === 0
      ? []
      : [{ ...group, courts, allCourts: group.courts }];
  });
  return (
    <div className="min-w-0 space-y-2">
      <SearchField
        value={query}
        onValueChange={setQuery}
        clearLabel={props.clearLabel}
        aria-label={props.searchLabel}
        placeholder={props.searchLabel}
      />
      <ScrollArea className="h-72" axis="vertical" aria-label={props.label}>
        <div className="space-y-2">
          {visible.length === 0 && (
            <p className="text-muted-foreground py-2 text-sm">
              {props.emptyLabel}
            </p>
          )}
          {visible.map((group) => (
            <fieldset key={group.value} className="min-w-0">
              <legend className="sr-only">{group.label}</legend>
              {props.mode === "multiple" ? (
                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-xs font-medium">
                  <Checkbox
                    checked={group.allCourts.every(({ value }) =>
                      selected.includes(value),
                    )}
                    indeterminate={
                      group.allCourts.some(({ value }) =>
                        selected.includes(value),
                      ) &&
                      !group.allCourts.every(({ value }) =>
                        selected.includes(value),
                      )
                    }
                    onCheckedChange={() =>
                      props.onChange(
                        toggleCourtSelection(
                          selected,
                          group.allCourts.map(({ value }) => value),
                        ),
                      )
                    }
                  />
                  {group.label}
                </label>
              ) : (
                <p className="text-muted-foreground py-1 text-xs font-medium">
                  {group.label}
                </p>
              )}
              {group.courts.map(({ value, label, badgeText }) => (
                <label
                  key={value}
                  className="has-[:focus-visible]:ring-ring flex min-h-11 cursor-pointer items-center gap-2 rounded-sm text-sm has-[:focus-visible]:ring-2"
                >
                  {props.mode === "multiple" ? (
                    <Checkbox
                      checked={selected.includes(value)}
                      onCheckedChange={() =>
                        props.onChange(toggleCourtSelection(selected, [value]))
                      }
                    />
                  ) : (
                    <input
                      type="radio"
                      name={radioName}
                      value={value}
                      checked={props.selected === value}
                      className="accent-primary size-4 shrink-0"
                      onChange={() => props.onChange(value)}
                      onClick={() => {
                        if (props.selected === value) {
                          props.onChange(undefined);
                        }
                      }}
                    />
                  )}
                  <span className="min-w-0 flex-1 wrap-break-word">
                    {label ?? value}
                  </span>
                  {badgeText !== undefined && (
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {badgeText}
                    </span>
                  )}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};
