import type { ComponentType, ReactNode } from "react";

import { ChevronDownIcon, ChevronsUpDownIcon } from "../icons";
import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { FIELD_TRIGGER_CLASS_NAME } from "../lib/field-trigger";
import { cn } from "../lib/utils";
import {
  BUTTON_BASE_CLASS,
  BUTTON_FACE_SIZE_CLASS_NAMES,
  BUTTON_LAYOUT_CLASS_NAMES,
  BUTTON_SIZE_CLASS_NAMES,
  BUTTON_VARIANT_CLASS_NAMES,
  type ButtonFaceSize,
} from "./button-classes";
import type { ButtonTokenVariant } from "./button.shared";
import {
  FIELD_CLASS_NAME,
  FIELD_DESCRIPTION_CLASS_NAME,
} from "./field-classes";
import {
  INPUT_CONTROL_CLASS_NAME,
  INPUT_ELEMENT_CLASS_NAME,
  INPUT_SIZE_CLASS_NAMES,
} from "./input-control";
import { LABEL_VARIANT_CLASS_NAME } from "./label-classes";
import {
  SELECT_TRIGGER_ICON_CLASS_NAME,
  SELECT_TRIGGER_SIZE_CLASS_NAMES,
  SELECT_VALUE_CLASS_NAME,
} from "./select-classes";
import { InlineSkeleton } from "./skeleton";
import {
  TABS_INDICATOR_DEFAULT_CLASS,
  TABS_LIST_BASE_CLASS,
  TABS_LIST_DEFAULT_CLASS,
  TABS_TAB_CLASS,
} from "./tabs-classes";
import {
  CHECKBOX_CLASS_NAME,
  SWITCH_ROOT_CLASS_NAME,
  SWITCH_ROOT_SIZE_CLASS_NAME,
  type SwitchSize,
} from "./toggle-classes";
import {
  SEGMENTED_ICON_TOGGLE_ICON_CLASS_NAME,
  segmentedIconToggleClassName,
  segmentedIconToggleItemClassName,
  TOGGLE_GROUP_CLASS_NAME,
  TOGGLE_GROUP_ITEM_CLASS_NAME,
} from "./toggle-group-classes";
import type { SegmentedIconToggleSize } from "./toggle-group-classes";

/*
 * The faces of controls a loading view draws before the page mounts: a
 * button, a text field, a picker's trigger, a select trigger, a
 * segmented toggle, a checkbox, a switch, a split button and a field's
 * caption with no behaviour, from the same classes the real controls are
 * built from, so the control that replaces a face lands in its box. A
 * face takes no focus and no click, says nothing to
 * assistive technology, and reads as unavailable, which it is until the page
 * is there. It imports no Base UI and no popup, so a pending view that the
 * server paints before the providers mount can draw one.
 */

/** How an unavailable control reads: the dimming a disabled one gets. */
const FACE_UNAVAILABLE_CLASS = "pointer-events-none opacity-64";

type ButtonFaceProps = {
  children?: ReactNode;
  className?: string | undefined;
  layout?: keyof typeof BUTTON_LAYOUT_CLASS_NAMES;
  size: ButtonFaceSize;
  variant: ButtonTokenVariant;
};

/**
 * A button face's classes: the box, size and variant colours of the button
 * it stands in for, unavailable. For the face of a button its caller
 * restyles, on an element of that caller's own.
 */
export const buttonFaceClassName = ({
  size,
  variant,
}: {
  size: ButtonFaceSize;
  variant: ButtonTokenVariant;
}): string =>
  cn(
    BUTTON_BASE_CLASS,
    BUTTON_SIZE_CLASS_NAMES[size],
    BUTTON_VARIANT_CLASS_NAMES[variant],
    size === "inline" && variant === "link" && "underline",
    FACE_UNAVAILABLE_CLASS,
  );

/** A button's face: its box, colours and content, disabled. */
export const ButtonFace = ({
  children,
  className,
  layout,
  size,
  variant,
}: ButtonFaceProps) => (
  <span
    aria-hidden="true"
    className={cn(
      buttonFaceClassName({ size, variant }),
      layout === undefined ? undefined : BUTTON_LAYOUT_CLASS_NAMES[layout],
      className,
    )}
    data-slot="button-face"
  >
    {children}
  </span>
);

/**
 * A bar on the line of text that waits on data (a chip's current choice, a
 * picker's selection, a message's line): one line box of the surrounding
 * text, so the text that replaces it keeps the line's height.
 */
export const FaceLabelPending = ({
  className = "w-16",
}: {
  /** The bar's width, roughly the label's. */
  className?: string | undefined;
}) => (
  <span
    aria-hidden="true"
    className="inline-flex h-[1lh] items-center align-top"
    data-slot="face-label-skeleton"
  >
    <InlineSkeleton className={cn("h-[0.75em]", className)} />
  </span>
);

type InputFaceProps = {
  /** The glyph at the field's start (a search field's magnifier). */
  icon?: ReactNode;
  /** The placeholder line, as the field shows it while empty. */
  children?: ReactNode;
  className?: string | undefined;
  size?: ControlSize;
  /** Classes for the line the placeholder sits on (the field's own box). */
  fieldClassName?: string | undefined;
};

/** A text field's face: its box and the placeholder. */
export const InputFace = ({
  children,
  className,
  fieldClassName,
  icon,
  size = CONTROL_SIZE.default,
}: InputFaceProps) => (
  <span
    aria-hidden="true"
    className={cn(
      INPUT_CONTROL_CLASS_NAME,
      "items-center",
      FACE_UNAVAILABLE_CLASS,
      className,
    )}
    data-slot="input-face"
  >
    {icon !== undefined && (
      <span className="text-muted-foreground pointer-events-none absolute inset-y-0 start-2.5 z-1 flex items-center opacity-80 [&_svg]:size-3.5">
        {icon}
      </span>
    )}
    <span
      className={cn(
        INPUT_ELEMENT_CLASS_NAME,
        INPUT_SIZE_CLASS_NAMES[size],
        "text-foreground-placeholder flex items-center overflow-hidden whitespace-nowrap",
        icon !== undefined && "ps-8",
        fieldClassName,
      )}
    >
      {children}
    </span>
  </span>
);

type SelectTriggerFaceProps = {
  /** The chosen value's text, or a bar while it waits on data. */
  children?: ReactNode;
  className?: string | undefined;
  size?: ControlSize;
};

/** A select trigger's face: its box, the chosen value and the chevrons. */
export const SelectTriggerFace = ({
  children,
  className,
  size = CONTROL_SIZE.default,
}: SelectTriggerFaceProps) => (
  <span
    aria-hidden="true"
    className={cn(
      FIELD_TRIGGER_CLASS_NAME,
      SELECT_TRIGGER_SIZE_CLASS_NAMES[size],
      FACE_UNAVAILABLE_CLASS,
      className,
    )}
    data-slot="select-trigger-face"
  >
    <span className={SELECT_VALUE_CLASS_NAME}>{children}</span>
    {/* The span Base UI's `Select.Icon` draws around the chevrons. */}
    <span>
      <ChevronsUpDownIcon className={SELECT_TRIGGER_ICON_CLASS_NAME} />
    </span>
  </span>
);

type SegmentedIconToggleFaceProps<T extends string> = {
  options: readonly {
    value: T;
    icon: ComponentType<{ className?: string }>;
  }[];
  /** The chosen option, or none while the choice is not read yet. */
  value?: T | undefined;
  size?: SegmentedIconToggleSize;
};

/**
 * A segmented icon toggle's face (./segmented-icon-toggle.tsx): the tray and
 * its icon items, the chosen one raised as the toggle raises it.
 */
export const SegmentedIconToggleFace = <T extends string>({
  options,
  size = "compact",
  value,
}: SegmentedIconToggleFaceProps<T>) => (
  <span
    aria-hidden="true"
    className={cn(
      TOGGLE_GROUP_CLASS_NAME,
      segmentedIconToggleClassName(size),
      FACE_UNAVAILABLE_CLASS,
    )}
    data-slot="segmented-icon-toggle-face"
  >
    {options.map((option) => {
      const Icon = option.icon;
      return (
        <span
          className={cn(
            BUTTON_BASE_CLASS,
            BUTTON_FACE_SIZE_CLASS_NAMES["icon-xs"],
            BUTTON_VARIANT_CLASS_NAMES.muted,
            TOGGLE_GROUP_ITEM_CLASS_NAME,
            segmentedIconToggleItemClassName(size),
          )}
          data-pressed={option.value === value ? "" : undefined}
          key={option.value}
        >
          <Icon className={SEGMENTED_ICON_TOGGLE_ICON_CLASS_NAME} />
        </span>
      );
    })}
  </span>
);

/**
 * The face of a picker's trigger inside a form (a select, a combobox with
 * `variant="field"`): the field box, the current choice, and the up-down
 * chevron at the end.
 */
export const FieldTriggerFace = ({
  children,
  className,
}: {
  /** The current choice, or a bar while it waits on data. */
  children?: ReactNode;
  className?: string | undefined;
}) => (
  <span
    aria-hidden="true"
    className={cn(FIELD_TRIGGER_CLASS_NAME, FACE_UNAVAILABLE_CLASS, className)}
    data-slot="field-trigger-face"
  >
    <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
      {children}
    </span>
    <ChevronsUpDownIcon className="-me-1 size-4.5 opacity-80 sm:size-4" />
  </span>
);

/** A checkbox's face: its box, unticked (the value waits on data). */
export const CheckboxFace = ({
  className,
}: {
  className?: string | undefined;
}) => (
  <span
    aria-hidden="true"
    className={cn(CHECKBOX_CLASS_NAME, FACE_UNAVAILABLE_CLASS, className)}
    data-slot="checkbox-face"
  />
);

/** A switch's face: its track, off (the value waits on data). */
export const SwitchFace = ({
  className,
  size = "default",
}: {
  className?: string | undefined;
  size?: SwitchSize | undefined;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      SWITCH_ROOT_CLASS_NAME,
      SWITCH_ROOT_SIZE_CLASS_NAME[size],
      "bg-switch-track",
      FACE_UNAVAILABLE_CLASS,
      className,
    )}
    data-slot="switch-face"
  />
);

/**
 * A field's caption, as `Label` draws it (its `default` variant), for a
 * label whose text a pending view renders itself (a bar until the app's
 * messages are there).
 */
export const LabelFace = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) => (
  <span
    className={cn(LABEL_VARIANT_CLASS_NAME.default, className)}
    data-slot="label-face"
  >
    {children}
  </span>
);

/**
 * How a field's face lays out its parts, in `Form`'s names: `stack` puts the
 * caption over the control over its lines (the field's column), `inline` a
 * checkbox or switch beside its caption.
 */
type FieldFaceLayout = "stack" | "inline";

const FIELD_FACE_LAYOUT_CLASS_NAMES = {
  stack: "",
  inline: "flex-row items-center",
} as const satisfies Record<FieldFaceLayout, string>;

/**
 * How close a field's face sets its parts: `snug` a step closer (a checkbox
 * row over its line).
 */
type FieldFaceDensity = "default" | "snug";

const FIELD_FACE_DENSITY_CLASS_NAMES = {
  default: "",
  snug: "gap-1",
} as const satisfies Record<FieldFaceDensity, string>;

/**
 * A form field's face, as `Field` draws it: the caption, the control's face
 * and the quiet lines a pending view puts in, in the field's own box.
 */
export const FieldFace = ({
  children,
  className,
  density = "default",
  layout = "stack",
}: {
  children: ReactNode;
  className?: string | undefined;
  density?: FieldFaceDensity | undefined;
  layout?: FieldFaceLayout | undefined;
}) => (
  <div
    className={cn(
      FIELD_CLASS_NAME,
      FIELD_FACE_LAYOUT_CLASS_NAMES[layout],
      FIELD_FACE_DENSITY_CLASS_NAMES[density],
      className,
    )}
    data-slot="field-face"
  >
    {children}
  </div>
);

/** A field's quiet line, as `FieldDescription` draws it. */
export const FieldDescriptionFace = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) => (
  <p
    className={cn(FIELD_DESCRIPTION_CLASS_NAME, className)}
    data-slot="field-description-face"
  >
    {children}
  </p>
);

/**
 * A `default` tab strip's face: the well, each tab's box and label, and the
 * raised chip under the tab that opens first.
 */
export const TabsFace = ({
  activeIndex = 0,
  tabs,
}: {
  /** The tabs in order, each with its label (or a bar). */
  tabs: readonly { key: string; label: ReactNode }[];
  /** Which tab is open when the strip mounts. */
  activeIndex?: number | undefined;
}) => (
  <span
    aria-hidden="true"
    className={cn(
      TABS_LIST_BASE_CLASS,
      TABS_LIST_DEFAULT_CLASS,
      // Decoration: it never scrolls, it stays inside its box.
      "pointer-events-none overflow-hidden",
    )}
    data-slot="tabs-face"
  >
    {tabs.map((tab, index) => (
      <span
        className={cn(
          TABS_TAB_CLASS,
          index === activeIndex && "text-foreground",
        )}
        key={tab.key}
      >
        {index === activeIndex && (
          <span
            // The live chip covers the tab's border box, not its padding box.
            className={cn("absolute -inset-px", TABS_INDICATOR_DEFAULT_CLASS)}
          />
        )}
        {tab.label}
      </span>
    ))}
  </span>
);

/** A split button's sizes (./split-button.tsx), one class set per part. */
export type SplitButtonSize = "sm" | "md";

/** The quiet chrome around both halves. */
export const SPLIT_BUTTON_ROOT_CLASS =
  "group/split hover:border-border focus-within:border-border has-[[data-popup-open]]:border-border inline-flex shrink-0 items-center rounded-lg border border-transparent p-0.5";

/** The primary half, over the `sm` ghost button it is built on. */
export const SPLIT_BUTTON_PRIMARY_CLASS = {
  md: "active:bg-accent/80 rounded-md [&_svg]:mx-0 [&_svg]:size-3.5 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3.5 h-8 ps-2 pe-0.5 sm:h-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  sm: "active:bg-accent/80 rounded-md [&_svg]:mx-0 [&_svg]:size-3.5 [&_svg:not([class*='size-'])]:size-3.5 sm:[&_svg:not([class*='size-'])]:size-3.5 h-7 ps-1.5 pe-0.5 sm:h-7 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
} as const satisfies Record<SplitButtonSize, string>;

/** The chevron half, over the `sm` ghost button it is built on. */
export const SPLIT_BUTTON_TRIGGER_CLASS = {
  md: "group-hover/split:bg-muted group-focus-within/split:bg-muted hover:bg-accent active:bg-accent/80 data-popup-open:bg-accent rounded-md [&_svg]:mx-0 h-8 w-4 px-0 sm:h-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
  sm: "group-hover/split:bg-muted group-focus-within/split:bg-muted hover:bg-accent active:bg-accent/80 data-popup-open:bg-accent rounded-md [&_svg]:mx-0 h-7 w-3.5 px-0 sm:h-7 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
} as const satisfies Record<SplitButtonSize, string>;

/** The chevron that opens the secondary surface. */
export const SplitButtonChevron = () => (
  <ChevronDownIcon
    aria-hidden="true"
    className="size-[0.65625rem]"
    strokeWidth={1.5}
  />
);

/** A split button's face: both halves, the primary glyph, the chevron. */
export const SplitButtonFace = ({
  children,
  size = "md",
}: {
  children: ReactNode;
  size?: SplitButtonSize;
}) => (
  <span
    aria-hidden="true"
    className={cn(SPLIT_BUTTON_ROOT_CLASS, "pointer-events-none")}
    data-slot="split-button-face"
  >
    <ButtonFace
      className={SPLIT_BUTTON_PRIMARY_CLASS[size]}
      size="sm"
      variant="ghost"
    >
      {children}
    </ButtonFace>
    <ButtonFace
      className={SPLIT_BUTTON_TRIGGER_CLASS[size]}
      size="sm"
      variant="ghost"
    >
      <SplitButtonChevron />
    </ButtonFace>
  </span>
);
