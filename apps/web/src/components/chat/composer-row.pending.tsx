import type { ReactNode } from "react";

import { ComposerFrame } from "@stll/ui/composer-frame";
import {
  ButtonFace,
  buttonFaceClassName,
  SplitButtonFace,
} from "@stll/ui/control-face";
import { AiActionIcon, ArrowUpIcon, PlusIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

/*
 * The faces of the chat bar's known controls, for the loading views that
 * stand in for it. Each is drawn from the control's own button classes, and
 * each loading view seats them in the same `ComposerFrame` the live bar
 * renders through, so the row a pending view draws and the bar that replaces
 * it share one geometry.
 */

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
 * The chat bar (`ChatInputSurface`, compact) before it mounts: the frame with
 * the (+) menu, the placeholder line and the improve and send controls, and
 * the status row the surface puts beneath.
 */
export const ChatComposerPending = ({
  dock,
  placeholder,
}: {
  dock: ReactNode;
  placeholder: ReactNode;
}) => (
  <div className="flex flex-col">
    <ComposerFrame
      aria-hidden="true"
      empty
      leading={<ComposerPlusFace />}
      placeholder={
        <span className="block min-w-0 overflow-hidden whitespace-nowrap">
          {placeholder}
        </span>
      }
      ring="none"
      stature="compact"
      text={null}
      trailing={
        <>
          <span className={COMPOSER_IMPROVE_SEAT_CLASS}>
            <ComposerImproveFace />
          </span>
          <ComposerSendFace />
        </>
      }
    />
    {dock}
  </div>
);
