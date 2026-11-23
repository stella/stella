import { createContext, useRef, useState } from "react";
import type { ComponentProps } from "react";

import { cn } from "@stll/ui/utils";

import { WorkspaceGridCell } from "@/components/workspaces/table/workspace-grid";

export const TableCellEngagement = createContext(false);

const REVIEWABLE_CELL = "[data-reviewable-table-cell]";

const nextReviewableCell = (cell: HTMLElement, key: string) => {
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const rtl = getComputedStyle(cell).direction === "rtl";
    const next = (key === "ArrowRight") !== rtl;
    const sibling = next ? "nextElementSibling" : "previousElementSibling";
    for (
      let candidate = cell[sibling];
      candidate;
      candidate = candidate[sibling]
    ) {
      if (
        candidate instanceof HTMLElement &&
        candidate.matches(REVIEWABLE_CELL)
      ) {
        return candidate;
      }
    }
  }

  if (key === "ArrowUp" || key === "ArrowDown") {
    const sibling =
      key === "ArrowDown" ? "nextElementSibling" : "previousElementSibling";
    const column = cell.getAttribute("aria-colindex");
    for (let row = cell.parentElement?.[sibling]; row; row = row[sibling]) {
      const candidate = Array.from(row.querySelectorAll(REVIEWABLE_CELL)).find(
        (element) => element.getAttribute("aria-colindex") === column,
      );
      if (candidate instanceof HTMLElement) {
        return candidate;
      }
    }
  }

  return null;
};

export const ReviewableTableCell = ({
  children,
  className,
  ...props
}: ComponentProps<typeof WorkspaceGridCell>) => {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const selectOnTouch = useRef(false);

  return (
    <WorkspaceGridCell
      {...props}
      className={cn(
        "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        className,
      )}
      data-reviewable-table-cell=""
      onBlur={(event) => {
        const nextFocus = event.relatedTarget;
        if (
          !(nextFocus instanceof Node) ||
          !event.currentTarget.contains(nextFocus)
        ) {
          setFocused(false);
        }
      }}
      onClickCapture={(event) => {
        const shouldSelect = selectOnTouch.current && event.detail > 0;
        selectOnTouch.current = false;
        if (!shouldSelect) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus({ preventScroll: true });
      }}
      onFocus={() => setFocused(true)}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        ) {
          return;
        }
        const nextCell = nextReviewableCell(event.currentTarget, event.key);
        if (nextCell) {
          event.preventDefault();
          event.stopPropagation();
          nextCell.focus();
        }
      }}
      onPointerCancel={() => {
        selectOnTouch.current = false;
      }}
      onPointerDownCapture={(event) => {
        selectOnTouch.current = event.pointerType === "touch" && !focused;
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          setHovered(true);
        }
      }}
      onPointerLeave={() => setHovered(false)}
      tabIndex={0}
    >
      <TableCellEngagement value={hovered || focused}>
        {children}
      </TableCellEngagement>
    </WorkspaceGridCell>
  );
};
