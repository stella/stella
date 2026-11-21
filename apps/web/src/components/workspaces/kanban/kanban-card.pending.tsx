import { FaceLabelPending } from "@stll/ui/control-face";
import { KanbanCardShell } from "@stll/ui/kanban-card-shell";

/** A card's content column: the name row, then its badges and values. */
export const KANBAN_CARD_CONTENT_CLASS = "flex flex-col gap-2 pe-5";

/** A card's first row: its icon and name. */
export const KANBAN_CARD_NAME_ROW_CLASS =
  "flex min-w-0 items-center gap-1.5 text-sm leading-snug font-medium";

/** How many cards a column shows while its first page loads. */
const KANBAN_CARDS_PENDING = Array.from(
  { length: 3 },
  (_, slot) => `card-${String(slot)}`,
);

/**
 * A column's cards while its first page loads: placeholder cards in the
 * card's own shell and rows, a bar on the name's line and one on the line
 * under it, so the cards that arrive land where the placeholders were.
 */
export const KanbanCardsPending = () => (
  <div aria-hidden="true" className="flex flex-col gap-2 pb-2">
    {KANBAN_CARDS_PENDING.map((key) => (
      <KanbanCardShell key={key}>
        <div className={KANBAN_CARD_CONTENT_CLASS}>
          <span className={KANBAN_CARD_NAME_ROW_CLASS}>
            <FaceLabelPending className="w-3/4" />
          </span>
          <span className="text-muted-foreground text-xs">
            <FaceLabelPending className="w-1/3" />
          </span>
        </div>
      </KanbanCardShell>
    ))}
  </div>
);
