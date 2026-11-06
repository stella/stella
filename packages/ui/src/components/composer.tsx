"use client";

import type { ReactNode } from "react";

import { ChevronDownIcon } from "../icons";
import { cn } from "../lib/utils";
import { COMPOSER_PICKER_TRIGGER_CLASS } from "./composer-tokens";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./menu";

export {
  COMPOSER_CONTROL_BUTTON_SIZE,
  COMPOSER_BOX_CLASS,
  COMPOSER_BOX_FOCUS_CLASS,
  COMPOSER_BOX_ANONYMIZED_CLASS,
  COMPOSER_COMPACT_ROW_CLASS,
  COMPOSER_COMPACT_TEXT_CELL_CLASS,
  COMPOSER_TEXT_CLASS,
  COMPOSER_LARGE_TEXT_WELL_CLASS,
  COMPOSER_LARGE_EDITOR_CLASS,
  COMPOSER_PLACEHOLDER_CLASS,
  COMPOSER_LARGE_ACTION_ROW_CLASS,
  COMPOSER_LEADING_GROUP_CLASS,
  COMPOSER_SEND_BUTTON_CLASS,
  COMPOSER_PICKER_TRIGGER_CLASS,
} from "./composer-tokens";

type ComposerStatusRowProps = {
  /** Left cluster: matter picker, web-search / anonymize toggles, ... */
  start?: ReactNode | undefined;
  /** End slot, pinned to the far edge (e.g. the context meter). */
  end?: ReactNode | undefined;
  /**
   * Middle slot, centered on the row (e.g. scroll to the latest message).
   * With it the row becomes three columns whose sides share the remaining
   * width equally, so the middle stays centered and never covers a control.
   * The row is a size container, so the middle can drop its label when the
   * row is narrow (`@md:` variants).
   */
  center?: ReactNode | undefined;
  className?: string | undefined;
};

/**
 * The slim status row rendered beneath a composer box: a `text-xs` row with
 * a start cluster and an end slot pinned to the far edge. Shared by every
 * surface so the shell can never drift. Renders nothing when both slots are
 * empty, so a surface with no per-send controls shows no row.
 */
export const ComposerStatusRow = ({
  start,
  end,
  center,
  className,
}: ComposerStatusRowProps) => {
  if (start === undefined && end === undefined && center === undefined) {
    return null;
  }

  if (center !== undefined) {
    return (
      <div
        className={cn(
          "text-muted-foreground @container mt-1.5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 px-1 text-xs",
          className,
        )}
      >
        <div className="flex min-w-0 items-center">{start}</div>
        <div className="flex items-center justify-center">{center}</div>
        <div className="flex min-w-0 items-center justify-end">{end}</div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "text-muted-foreground mt-1.5 flex items-center justify-between gap-2 px-1 text-xs",
        className,
      )}
    >
      {start}
      {end !== undefined && <div className="ms-auto">{end}</div>}
    </div>
  );
};

export type ComposerPickerOption<Value extends string> = {
  label: string;
  value: Value;
};

type ComposerPickerProps<Value extends string> = {
  /** The accessible name of the choice, e.g. "Jurisdiction". */
  ariaLabel: string;
  /** The glyph before the current choice, sized `size-3` by the trigger. */
  icon: ReactNode;
  onChange: (value: Value) => void;
  options: readonly ComposerPickerOption<Value>[];
  value: Value;
};

/**
 * One choice among a few in the status row under a composer box: the
 * trigger the chat's matter picker renders, with a radio menu behind it.
 * Every picker under a box renders through this so the row reads as one
 * kind of control.
 */
export const ComposerPicker = <Value extends string>({
  ariaLabel,
  icon,
  onChange,
  options,
  value,
}: ComposerPickerProps<Value>) => {
  const current = options.find((option) => option.value === value);

  return (
    <Menu>
      <MenuTrigger
        aria-label={ariaLabel}
        className={COMPOSER_PICKER_TRIGGER_CLASS}
      >
        <span className="flex size-3 shrink-0 items-center justify-center [&>svg]:size-3">
          {icon}
        </span>
        <span className="truncate">{current?.label ?? value}</span>
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3 shrink-0 opacity-70"
        />
      </MenuTrigger>
      <MenuPopup align="start" sideOffset={6}>
        <MenuRadioGroup value={value}>
          {options.map((option) => (
            <MenuRadioItem
              key={option.value}
              onClick={() => onChange(option.value)}
              value={option.value}
            >
              {option.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};
