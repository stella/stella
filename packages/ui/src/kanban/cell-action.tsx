import type { ComponentProps } from "react";

import { PlusIcon } from "lucide-react";

import { Button } from "../components/button";
import { cn } from "../lib/utils";
import { KANBAN_CHROME_ROW_HEIGHT } from "./layout-tokens";

export type KanbanCellActionProps = Omit<
  ComponentProps<typeof Button>,
  "variant"
>;

/**
 * The quiet action at the end of a cell: a full-width row that adds a card to
 * that column and lane.
 *
 * Every board rendered its own copy of this row and the copies drifted in
 * height, tone, and icon size. One primitive keeps the footer of every cell on
 * the same rhythm as a card, so an empty cell and a full one end the same way.
 *
 * It is drawn as the outline of a card rather than as a button: the row stands
 * where the next card will, so a dashed card-shaped slot says what pressing it
 * produces, which a ghost button in the same place never did. It stays a
 * `Button` underneath for the focus ring and the coarse-pointer touch target
 * the variant already carries; only the height is restated per breakpoint,
 * since the button's own size drops a step at `sm` and the row has to hold the
 * board's chrome rhythm at every width.
 */
export const KanbanCellAction = ({
  children,
  className,
  ...props
}: KanbanCellActionProps) => (
  <Button
    className={cn(
      "border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground flex w-full items-center justify-start gap-1.5 rounded-lg border border-dashed px-3 text-sm",
      KANBAN_CHROME_ROW_HEIGHT,
      "sm:h-9",
      className,
    )}
    data-slot="kanban-cell-action"
    {...props}
    variant="ghost"
  >
    <PlusIcon className="size-3.5" />
    {children}
  </Button>
);
