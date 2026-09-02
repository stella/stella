import type { ComponentProps } from "react";

import { PlusIcon } from "lucide-react";

import { Button } from "../components/button";
import { cn } from "../lib/utils";

export type KanbanCellActionProps = Omit<
  ComponentProps<typeof Button>,
  "variant"
>;

/**
 * The quiet action at the end of a cell: a full-width ghost row that adds a
 * card to that column and lane.
 *
 * Every board rendered its own copy of this row and the copies drifted in
 * height, tone, and icon size. One primitive keeps the footer of every cell on
 * the same rhythm as a card, so an empty cell and a full one end the same way.
 */
export const KanbanCellAction = ({
  children,
  className,
  ...props
}: KanbanCellActionProps) => (
  <Button
    className={cn(
      "text-muted-foreground hover:text-foreground min-h-11 w-full justify-start gap-1.5",
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
