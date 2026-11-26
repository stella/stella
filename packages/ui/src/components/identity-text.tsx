"use client";

import { useId, useState } from "react";

import { useObservedValue } from "../effects/dom";
import { useExternalSyncEffect } from "../effects/effects";
import { cn } from "../lib/utils";
import { withoutDirectionalControls } from "./bidi-text";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import { TruncatedText } from "./truncated-text";

type IdentityTextProps = {
  children: string;
  className?: string;
};

const UNMEASURED = { overflow: false, hasFocusOwner: false };

const focusOwnerOf = (node: HTMLElement): Element | null =>
  node.parentElement?.closest("a[href],button,[tabindex]") ?? null;

/** Discloses clipped names on hover and when their owning control receives focus. */
export const IdentityText = ({ children, className }: IdentityTextProps) => {
  const triggerId = useId();
  const [node, setNode] = useState<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const name = withoutDirectionalControls(children);
  const { overflow, hasFocusOwner } = useObservedValue<
    HTMLSpanElement,
    { overflow: boolean; hasFocusOwner: boolean }
  >(
    node,
    (observed, emit) => {
      const hasOwner = focusOwnerOf(observed) !== null;
      const measure = () =>
        emit({
          overflow: observed.scrollWidth > observed.clientWidth,
          hasFocusOwner: hasOwner,
        });
      const observer = new ResizeObserver(measure);
      observer.observe(observed);
      const contentObserver = new MutationObserver(measure);
      contentObserver.observe(observed, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      measure();
      return () => {
        observer.disconnect();
        contentObserver.disconnect();
      };
    },
    [],
    UNMEASURED,
  );
  // The owning control's focus opens the hint, its blur closes it.
  useExternalSyncEffect(() => {
    const focusOwner = node === null ? null : focusOwnerOf(node);
    if (focusOwner === null) {
      return undefined;
    }
    const show = () => setOpen(true);
    const hide = () => setOpen(false);
    focusOwner.addEventListener("focus", show);
    focusOwner.addEventListener("blur", hide);
    return () => {
      focusOwner.removeEventListener("focus", show);
      focusOwner.removeEventListener("blur", hide);
    };
  }, [node]);

  return (
    <Tooltip
      disabled={!overflow}
      onOpenChange={setOpen}
      open={overflow && open}
      triggerId={triggerId}
    >
      <TooltipTrigger
        id={triggerId}
        onClick={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        // TruncatedText cuts the name at its container; the tooltip here is
        // its hint, because it also opens when the owning control takes focus.
        render={
          <TruncatedText
            className={cn(
              "focus-visible:ring-ring outline-none [unicode-bidi:isolate] focus-visible:ring-2",
              className,
            )}
            dir="auto"
            hint={false}
            ref={setNode}
            role={overflow && !hasFocusOwner ? "button" : undefined}
            tabIndex={overflow && !hasFocusOwner ? 0 : undefined}
          />
        }
      >
        {name}
      </TooltipTrigger>
      {/* Beside the name, never above or below it: clipped names sit in
          stacked rows, and a popup over the next row hides the row the
          pointer is heading to. */}
      <TooltipPopup className="max-w-sm" role="tooltip" side="inline-end">
        <span className="block max-w-sm wrap-break-word" dir="auto">
          {name}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
};
