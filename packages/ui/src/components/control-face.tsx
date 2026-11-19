import type { ReactNode } from "react";

import { ChevronDownIcon, ChevronsUpDownIcon } from "../icons";
import { FIELD_TRIGGER_CLASS_NAME } from "../lib/field-trigger";
import { cn } from "../lib/utils";
import {
  BUTTON_BASE_CLASS,
  BUTTON_FACE_SIZE_CLASS_NAMES,
  BUTTON_VARIANT_CLASS_NAMES,
  type ButtonFaceSize,
} from "./button-classes";
import type { ButtonTokenVariant } from "./button.shared";
import {
  INPUT_CONTROL_CLASS_NAME,
  INPUT_ELEMENT_CLASS_NAME,
} from "./input-control";
import { LABEL_VARIANT_CLASS_NAME } from "./label-classes";
import { Skeleton } from "./skeleton";
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

/*
 * The faces of controls a loading view draws before the page mounts: a
 * button, a text field, a picker's trigger, a checkbox, a switch, a split
 * button and a field's caption with no behaviour, from the same classes the
 * real controls are built from, so the control that replaces a face lands in
 * its box. A face takes no focus and no click, says nothing to
 * assistive technology, and reads as unavailable, which it is until the page
 * is there. It imports no Base UI and no popup, so a pending view that the
 * server paints before the providers mount can draw one.
 */

/** How an unavailable control reads: the dimming a disabled one gets. */
const FACE_UNAVAILABLE_CLASS = "pointer-events-none opacity-64";

type ButtonFaceProps = {
  children?: ReactNode;
  className?: string | undefined;
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
    BUTTON_FACE_SIZE_CLASS_NAMES[size],
    BUTTON_VARIANT_CLASS_NAMES[variant],
    FACE_UNAVAILABLE_CLASS,
  );

/** A button's face: its box, colours and content, disabled. */
export const ButtonFace = ({
  children,
  className,
  size,
  variant,
}: ButtonFaceProps) => (
  <span
    aria-hidden="true"
    className={cn(buttonFaceClassName({ size, variant }), className)}
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
    className="inline-flex h-[1lh] items-center"
    data-slot="face-label-skeleton"
  >
    <Skeleton className={cn("h-[0.75em]", className)} />
  </span>
);

type InputFaceProps = {
  /** The glyph at the field's start (a search field's magnifier). */
  icon?: ReactNode;
  /** The placeholder line, as the field shows it while empty. */
  children?: ReactNode;
  className?: string | undefined;
};

/** A text field's face at its default size: the box and the placeholder. */
export const InputFace = ({ children, className, icon }: InputFaceProps) => (
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
        "text-foreground-placeholder flex items-center overflow-hidden whitespace-nowrap",
        icon !== undefined && "ps-8",
      )}
    >
      {children}
    </span>
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
      "bg-input",
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
      "pointer-events-none",
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
