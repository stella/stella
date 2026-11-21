"use client";

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { cn } from "../lib/utils";
import { TABLE_FIRST_LINE } from "./table-layout";
import type { TableFirstLine } from "./table-layout";
import { CHECKBOX_CLASS_NAME } from "./toggle-classes";

const Checkbox = (props: CheckboxProps) => {
  if (props.appearance === "cell") {
    return renderCellCheckbox(props);
  }
  return renderDefaultCheckbox(props);
};

type DefaultCheckboxProps = CheckboxPrimitive.Root.Props & {
  appearance?: "default";
};

type CellCheckboxProps = Omit<
  CheckboxPrimitive.Root.Props,
  | "children"
  | "render"
  | "nativeButton"
  | "readOnly"
  | "defaultChecked"
  | "checked"
  | "className"
  | "style"
> & {
  appearance: "cell";
  checked: boolean;
  /** The row's visible number or label, before its checkbox is revealed. */
  rowLabel: string;
  /** Aligns the label and glyph with a text line or a field's first line. */
  firstLine: TableFirstLine;
  onCheckedChange: NonNullable<CheckboxPrimitive.Root.Props["onCheckedChange"]>;
};

type CheckboxProps = DefaultCheckboxProps | CellCheckboxProps;

const renderDefaultCheckbox = ({
  appearance: _appearance,
  className,
  ...props
}: DefaultCheckboxProps) => (
  <CheckboxPrimitive.Root
    className={cn(CHECKBOX_CLASS_NAME, className)}
    data-slot="checkbox"
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={CHECKBOX_INDICATOR_CLASS_NAME}
      data-slot="checkbox-indicator"
      render={(indicatorProps, state) => (
        <span {...indicatorProps}>
          <CheckboxGlyph indeterminate={state.indeterminate} />
        </span>
      )}
    />
  </CheckboxPrimitive.Root>
);

const renderCellCheckbox = ({
  appearance,
  rowLabel,
  firstLine,
  checked,
  ...props
}: CellCheckboxProps) => (
  <CheckboxPrimitive.Root
    {...props}
    checked={checked}
    aria-label={props["aria-label"] ?? rowLabel}
    className="group/selection ring-ring hover:bg-muted/50 data-disabled:text-foreground-disabled absolute inset-0 min-w-12 shrink-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset data-disabled:cursor-not-allowed data-disabled:hover:bg-transparent"
    data-appearance={appearance}
    nativeButton
    render={<button type="button" />}
    readOnly={false}
    defaultChecked={undefined}
    style={undefined}
  >
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-x-0 top-2 flex min-w-12 items-center justify-center",
        TABLE_FIRST_LINE[firstLine].slot,
        "text-xs tabular-nums transition-opacity group-hover/row:opacity-0 group-focus-visible/selection:opacity-0 group-data-[state=selected]/row:opacity-0",
        checked && "opacity-0",
      )}
      data-slot="checkbox-cell-label"
    >
      {rowLabel}
    </span>
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-x-0 top-2 flex min-w-12 items-center justify-center",
        TABLE_FIRST_LINE[firstLine].slot,
        "pointer-events-none opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/selection:opacity-100 group-data-[state=selected]/row:opacity-100",
        checked && "opacity-100",
      )}
    >
      <CheckboxPrimitive.Indicator
        keepMounted
        className={CHECKBOX_CLASS_NAME}
        data-slot="checkbox"
        render={(indicatorProps, state) => (
          <span {...indicatorProps}>
            {(state.checked || state.indeterminate) && (
              <span
                className={CHECKBOX_INDICATOR_CLASS_NAME}
                data-checked={
                  state.checked && !state.indeterminate ? "" : undefined
                }
                data-indeterminate={state.indeterminate ? "" : undefined}
                data-slot="checkbox-indicator"
              >
                <CheckboxGlyph indeterminate={state.indeterminate} />
              </span>
            )}
          </span>
        )}
      />
    </span>
  </CheckboxPrimitive.Root>
);

const CHECKBOX_INDICATOR_CLASS_NAME =
  "text-primary-foreground data-checked:bg-primary data-indeterminate:text-foreground absolute -inset-px flex items-center justify-center rounded-sm data-unchecked:hidden";

const CheckboxGlyph = ({ indeterminate }: { indeterminate: boolean }) =>
  indeterminate ? (
    <svg
      aria-hidden="true"
      className="size-3.5 sm:size-3"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Indeterminate</title>
      <path d="M5.252 12h13.496" />
    </svg>
  ) : (
    <svg
      aria-hidden="true"
      className="size-3.5 sm:size-3"
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Checked</title>
      <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
    </svg>
  );

export { Checkbox };
