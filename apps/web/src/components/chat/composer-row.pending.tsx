import type { ComponentProps, ReactNode } from "react";

import {
  COMPOSER_BOX_CLASS,
  COMPOSER_COMPACT_ROW_CLASS,
  COMPOSER_COMPACT_TEXT_CELL_CLASS,
  COMPOSER_LEADING_GROUP_CLASS,
  COMPOSER_TEXT_CLASS,
} from "@stll/ui/composer-tokens";
import {
  ButtonFace,
  buttonFaceClassName,
  SplitButtonFace,
} from "@stll/ui/control-face";
import { AiActionIcon, ArrowUpIcon, PlusIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

/*
 * The compact composer row's seats and the faces of its known controls, for
 * the chat bar (`ChatInputSurface`) and the loading views that stand in for
 * it. The live bar seats its controls through the same classes, so the row a
 * pending view draws and the bar that replaces it share one geometry; the
 * faces are drawn from the controls' own button classes.
 */

/**
 * A round control's seat in the compact composer row: as tall as the row's
 * inner height, with the control centred in it. In a one-line row that
 * centres the control on the text; as the editor grows the row's `items-end`
 * keeps the seat on the last line, where the control stays centred on that
 * line. Every control in a compact row renders through this component; a
 * bare control would sink to the row's bottom edge, below the text's centre.
 */
export const ComposerControlSlot = ({
  className,
  ...props
}: ComponentProps<"span">) => (
  <span
    className={cn(
      "flex h-[calc(--spacing(11)-2px)] shrink-0 items-center",
      className,
    )}
    {...props}
  />
);

/** The compact chat bar's three columns: (+), the text, the trailing controls. */
export const COMPOSER_COMPACT_GRID_CLASS =
  "grid grid-cols-[auto_minmax(0,1fr)_auto]";

/** Where the (+) menu sits in the compact grid. */
export const COMPOSER_COMPACT_LEADING_SEAT_CLASS =
  "col-start-1 row-start-1 self-end";

/** Where the editor (or its placeholder) sits in the compact grid. */
export const COMPOSER_COMPACT_TEXT_SEAT_CLASS = "col-start-2 row-start-1";

/** Where the trailing controls (improve, queue, send) sit in the compact grid. */
export const COMPOSER_COMPACT_TRAILING_SEAT_CLASS =
  "col-start-3 row-start-1 self-end";

/** The trailing cluster's own layout, in either stature. */
export const COMPOSER_TRAILING_GROUP_CLASS = "flex items-center gap-0.5";

/** The space the improve control keeps from the send control beside it. */
export const COMPOSER_IMPROVE_SEAT_CLASS = "me-0.5 inline-flex";

/**
 * The (+) menu's trigger in its unavailable face: the `icon-sm` secondary
 * button with the ring and round shape the trigger gives it.
 */
export const ComposerPlusFace = () => (
  <span
    aria-hidden="true"
    className={cn(
      buttonFaceClassName({ size: "icon-sm", variant: "secondary" }),
      "border-border size-7 shrink-0 rounded-full border",
    )}
  >
    <PlusIcon className="size-4" />
  </span>
);

/** The send control in its unavailable face: the round send arrow. */
export const ComposerSendFace = () => (
  <ButtonFace size="icon-round" variant="composer">
    <span className="pointer-events-none relative size-3.5">
      <ArrowUpIcon className="absolute inset-0 mx-0! size-full" />
    </span>
  </ButtonFace>
);

/** The improve control in its unavailable face. */
const ComposerImproveFace = () => (
  <SplitButtonFace>
    <AiActionIcon aria-hidden="true" className="size-3.5" />
  </SplitButtonFace>
);

/**
 * The compact chat bar's row before its editor mounts: the (+) menu, the
 * placeholder line and the improve and send controls, each at the seat the
 * live bar gives it.
 */
const ComposerRowPending = ({ placeholder }: { placeholder: ReactNode }) => (
  <div
    aria-hidden="true"
    className={cn(COMPOSER_COMPACT_GRID_CLASS, COMPOSER_COMPACT_ROW_CLASS)}
  >
    <div
      className={cn(
        "overflow-hidden",
        COMPOSER_COMPACT_TEXT_SEAT_CLASS,
        COMPOSER_COMPACT_TEXT_CELL_CLASS,
      )}
    >
      <span
        className={cn(
          "text-foreground-placeholder block overflow-hidden whitespace-nowrap",
          COMPOSER_TEXT_CLASS,
        )}
      >
        {placeholder}
      </span>
    </div>
    <ComposerControlSlot
      className={cn(
        COMPOSER_LEADING_GROUP_CLASS,
        COMPOSER_COMPACT_LEADING_SEAT_CLASS,
      )}
    >
      <ComposerPlusFace />
    </ComposerControlSlot>
    <ComposerControlSlot
      className={cn(
        COMPOSER_TRAILING_GROUP_CLASS,
        COMPOSER_COMPACT_TRAILING_SEAT_CLASS,
      )}
    >
      <span className={COMPOSER_IMPROVE_SEAT_CLASS}>
        <ComposerImproveFace />
      </span>
      <ComposerSendFace />
    </ComposerControlSlot>
  </div>
);

/**
 * The chat bar (`ChatInputSurface`, compact) before it mounts: its bordered
 * box around the pending row, and the status row the surface puts beneath.
 */
export const ChatComposerPending = ({
  dock,
  placeholder,
}: {
  dock: ReactNode;
  placeholder: ReactNode;
}) => (
  <div className="flex flex-col">
    <div className={COMPOSER_BOX_CLASS}>
      <ComposerRowPending placeholder={placeholder} />
    </div>
    {dock}
  </div>
);
