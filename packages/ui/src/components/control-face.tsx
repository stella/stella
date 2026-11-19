import type { ReactNode } from "react";

import { ChevronDownIcon } from "../icons";
import { CONTROL_SIZE } from "../lib/control-size";
import type { ControlSize } from "../lib/control-size";
import { cn } from "../lib/utils";
import {
  BUTTON_BASE_CLASS,
  BUTTON_FACE_SIZE_CLASS_NAMES,
  BUTTON_LAYOUT_CLASS_NAMES,
  BUTTON_VARIANT_CLASS_NAMES,
  type ButtonFaceSize,
} from "./button-classes";
import type { ButtonTokenVariant } from "./button.shared";
import {
  INPUT_CONTROL_CLASS_NAME,
  INPUT_ELEMENT_CLASS_NAME,
  INPUT_SIZE_CLASS_NAMES,
} from "./input-control";
import { InlineSkeleton } from "./skeleton";

/*
 * The faces of controls a loading view draws before the page mounts: a
 * button, a text field and a split button with no behaviour, from the same
 * classes the real controls are built from, so the control that replaces a
 * face lands in its box. A face takes no focus and no click, says nothing to
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
    BUTTON_FACE_SIZE_CLASS_NAMES[size],
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
};

/** A text field's face: its box and the placeholder. */
export const InputFace = ({
  children,
  className,
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
      )}
    >
      {children}
    </span>
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
