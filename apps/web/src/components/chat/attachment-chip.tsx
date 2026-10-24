import type { ReactNode } from "react";

import { panic } from "better-result";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { cn } from "@stll/ui/utils";

import {
  CHIP_ACTION_CLASS,
  CHIP_HEIGHT_CLASS,
  CHIP_ICON_CLASS,
  CHIP_TOUCH_TARGET_CLASS,
} from "@/components/chip-scale";

export type AttachmentChipKind = "command" | "file" | "image" | "pasted_text";

export type AttachmentChipAction = {
  type: "expand" | "remove";
  label: string;
  icon: (props: { className: string }) => ReactNode;
  onClick: () => void;
  /** A disclosure action names the region it shows and whether it is open. */
  disclosure?: { controls: string; expanded: boolean } | undefined;
};

/** What activating the chip's title does: nothing, open a link, or act. */
export type AttachmentChipOpen =
  | { type: "none" }
  | { type: "link"; href: string }
  | { type: "action"; onClick: () => void };

type AttachmentChipProps = {
  kind: AttachmentChipKind;
  icon: (props: { className: string }) => ReactNode;
  title: string;
  open?: AttachmentChipOpen | undefined;
  actions?: readonly AttachmentChipAction[] | undefined;
};

const TITLE_CLASS = cn(
  "focus-visible:outline-ring max-w-40 min-w-0 truncate rounded-sm text-start focus-visible:outline-2",
  CHIP_TOUCH_TARGET_CLASS,
);

const OPEN_NONE: AttachmentChipOpen = { type: "none" };
const NO_ACTIONS: readonly AttachmentChipAction[] = [];

// The title is the tooltip's trigger: Base UI keeps the element's own
// children, so the label sits inside the button or link it names.
const titleElement = (open: AttachmentChipOpen, title: string) => {
  const label = <bdi>{title}</bdi>;
  switch (open.type) {
    case "none":
      return (
        <button
          className={cn(TITLE_CLASS, "cursor-default")}
          dir="auto"
          type="button"
        >
          {label}
        </button>
      );
    case "link":
      return (
        <a
          className={cn(TITLE_CLASS, "hover:underline")}
          dir="auto"
          href={sanitizeHref(open.href)}
          rel="noreferrer"
          target="_blank"
        >
          {label}
        </a>
      );
    case "action":
      return (
        <button
          className={cn(TITLE_CLASS, "hover:underline")}
          dir="auto"
          onClick={open.onClick}
          type="button"
        >
          {label}
        </button>
      );
    default:
      open satisfies never;
      return panic(`Unhandled attachment chip open: ${String(open)}`);
  }
};

/**
 * The shell of every attachment in a composer or a sent message. It owns the
 * size from the chip scale; a kind supplies only its icon, title and actions,
 * so no kind can draw a larger chip than another.
 */
export const AttachmentChip = ({
  kind,
  icon,
  title,
  open = OPEN_NONE,
  actions = NO_ACTIONS,
}: AttachmentChipProps) => (
  <span
    className={cn(
      "bg-muted/50 inline-flex w-fit max-w-full items-center gap-1 rounded-md border px-1.5 align-middle text-xs",
      CHIP_HEIGHT_CLASS,
    )}
    data-chip-kind={kind}
  >
    {icon({ className: cn(CHIP_ICON_CLASS, "text-muted-foreground") })}
    <Tooltip>
      <TooltipTrigger render={titleElement(open, title)} />
      <TooltipPopup>
        <bdi>{title}</bdi>
      </TooltipPopup>
    </Tooltip>
    {actions.map((action) => (
      <button
        aria-controls={action.disclosure?.controls}
        aria-expanded={action.disclosure?.expanded}
        aria-label={action.label}
        className={CHIP_ACTION_CLASS}
        key={action.type}
        onClick={action.onClick}
        title={action.label}
        type="button"
      >
        {action.icon({ className: "size-3" })}
      </button>
    ))}
  </span>
);
