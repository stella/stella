"use client";

import { useCallback, useId, useState } from "react";

import { cn } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

type IdentityTextProps = {
  children: string;
  className?: string;
};

/** Discloses clipped names on hover and when their owning control receives focus. */
export const IdentityText = ({ children, className }: IdentityTextProps) => {
  const triggerId = useId();
  const [overflow, setOverflow] = useState(false);
  const [hasFocusOwner, setHasFocusOwner] = useState(false);
  const [open, setOpen] = useState(false);
  const textRef = useCallback((node: HTMLSpanElement | null) => {
    if (node === null) {
      return undefined;
    }
    const measure = () => setOverflow(node.scrollWidth > node.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    const contentObserver = new MutationObserver(measure);
    contentObserver.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    measure();
    const focusOwner = node.parentElement?.closest("a[href],button,[tabindex]");
    setHasFocusOwner(focusOwner !== null && focusOwner !== undefined);
    const show = () => setOpen(true);
    const hide = () => setOpen(false);
    focusOwner?.addEventListener("focus", show);
    focusOwner?.addEventListener("blur", hide);
    return () => {
      observer.disconnect();
      contentObserver.disconnect();
      focusOwner?.removeEventListener("focus", show);
      focusOwner?.removeEventListener("blur", hide);
    };
  }, []);

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
        render={
          <span
            className={cn(
              "focus-visible:ring-ring block min-w-0 truncate outline-none [unicode-bidi:isolate] focus-visible:ring-2",
              className,
            )}
            dir="auto"
            ref={textRef}
            role={overflow && !hasFocusOwner ? "button" : undefined}
            tabIndex={overflow && !hasFocusOwner ? 0 : undefined}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup className="max-w-sm" role="tooltip">
        <span className="block max-w-sm wrap-break-word" dir="auto">
          {children}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
};
