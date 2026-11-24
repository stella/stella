import { useTranslations } from "use-intl";

import { Separator } from "@stll/ui/separator";

import type { ClipboardRailDivider as ClipboardRailDividerPosition } from "./clipboard-logic";

// Must match the divider's `w-10` and the empty-group line's `w-40` below.
const CLIPBOARD_RAIL_DIVIDER_WIDTH = 40;
const CLIPBOARD_RAIL_EMPTY_GROUP_WIDTH = 160;

/**
 * Where a split rail's divider sits and the room it takes, given the gap
 * the rail keeps between its children. A divider before the first card
 * follows the line saying the group has no matches.
 */
export const clipboardRailDivider = (
  index: number | null,
  gap: number,
): ClipboardRailDividerPosition | null =>
  index === null
    ? null
    : {
        advance:
          CLIPBOARD_RAIL_DIVIDER_WIDTH +
          gap +
          (index === 0 ? CLIPBOARD_RAIL_EMPTY_GROUP_WIDTH + gap : 0),
        index,
      };

/**
 * The divider between a group's own matches and every other match. It is a
 * separator with its label, never a focus stop, so moving along the rail
 * passes it like the gap between two cards.
 */
export const ClipboardRailDivider = ({
  groupEmpty,
}: {
  /** No clip of the group matches: say so before the divider. */
  groupEmpty: boolean;
}) => {
  const t = useTranslations("clipboard");
  const label = t("allResults");
  return (
    <>
      {groupEmpty ? (
        <p
          className="text-muted-foreground flex w-40 shrink-0 items-center text-sm text-pretty"
          data-clipboard-rail-empty-group=""
        >
          {t("noGroupMatches")}
        </p>
      ) : null}
      <div
        className="flex w-10 shrink-0 flex-col items-center gap-2 py-3"
        data-clipboard-rail-divider=""
      >
        {/* One separator carries the name; the drawn label and the lower
            line are its picture. */}
        <Separator
          aria-label={label}
          className="flex-1"
          orientation="vertical"
        />
        <span
          aria-hidden="true"
          className="text-muted-foreground rotate-180 text-xs font-medium whitespace-nowrap"
          style={{ writingMode: "vertical-rl" }}
        >
          {label}
        </span>
        <span aria-hidden="true" className="bg-border w-px flex-1" />
      </div>
    </>
  );
};
