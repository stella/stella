import type { ComponentProps, MouseEvent, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/tooltip";
import { containedEventHandler } from "../hooks/use-contained-handler";
import { cn } from "../lib/utils";
import { InspectorRailTab } from "./chrome";
import {
  resolveEntityTabActivateHandler,
  resolveEntityTabCloseHandler,
} from "./entity-tab.logic";
import { SIDE_RAIL_TAB_ICON_SIZE } from "./layout-tokens";

/**
 * One rail tab for an open entity: a bordered `InspectorRailTab` cell
 * showing the active tab's icon, with a tooltip carrying the full label.
 * Generic over what "entity" means — the host supplies the icon dispatch
 * (file type, task status, chat, …) and, for kinds that want it, the
 * inactive-state glyph; this only owns the cell's shared shape and
 * affordances.
 */
export const InspectorEntityTab = ({
  active,
  label,
  glyph,
  icon,
  onClose,
  onSelect,
  ...props
}: InspectorEntityTabProps) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <InspectorRailTab
          {...props}
          active={active}
          aria-label={label}
          onAuxClick={(event: MouseEvent<HTMLButtonElement>) => {
            const close = resolveEntityTabCloseHandler(event.button, onClose);
            if (close) {
              event.preventDefault();
              close();
            }
          }}
          onClick={containedEventHandler(
            resolveEntityTabActivateHandler(onSelect),
          )}
        >
          {/* Written as `InspectorRailTab`'s own JSX children (rather than
           * `TooltipTrigger`'s) so it's pinned after the `props` spread
           * above: `props` is typed without `children`, but a wider caller
           * value could still carry one, and a JSX child beats a spread
           * `children` positionally. */}
          {!active && glyph !== undefined ? (
            <span className="text-[9px] leading-none font-semibold tracking-tight uppercase">
              {glyph}
            </span>
          ) : (
            <span
              className={cn(
                "flex items-center justify-center",
                SIDE_RAIL_TAB_ICON_SIZE,
                // No glyph to swap to: dim the persistent icon instead, the
                // same `!active` treatment a registry-backed rail icon uses
                // on its own.
                !active && "opacity-70",
              )}
            >
              {icon}
            </span>
          )}
        </InspectorRailTab>
      }
    />
    <TooltipPopup side="left">{label}</TooltipPopup>
  </Tooltip>
);

type InspectorEntityTabPassthroughProps = Omit<
  ComponentProps<"button">,
  "children" | "onAuxClick" | "onClick"
>;

export type InspectorEntityTabProps = {
  /** Whether this tab is the one currently shown in the pane. Drives the
   * active spine, and — when `glyph` is given — swaps the cell's content
   * between `glyph` and `icon`. */
  active: boolean;
  /** Full entity name. Both the button's accessible name and the tooltip
   * text — the cell itself never has room to show it. */
  label: string;
  /**
   * Short text shown in the cell instead of `icon` while the tab is
   * inactive (e.g. a 3-character stem the host derives with
   * `entityTabGlyph`). Omit it for an entity kind whose icon alone already
   * identifies it (a status glyph, a colored dot, a logo): `icon` then
   * renders in both states, dimmed while inactive instead of swapping to
   * text.
   */
  glyph?: string | undefined;
  /** Shown in the cell while the tab is active — and, with no `glyph`,
   * while inactive too (dimmed). */
  icon: ReactNode;
  /**
   * Middle-click (`onAuxClick` button 1) closes the tab. A keyboard- and
   * pointer-reachable close affordance still has to exist — normally a
   * "Close" item in the host's own context menu, wired to the same
   * callback — this only covers the middle-click gesture.
   */
  onClose?: (() => void) | undefined;
  /** Fires on a (contained) left click: activate this tab. */
  onSelect?: (() => void) | undefined;
} & InspectorEntityTabPassthroughProps;

/**
 * Short abbreviation for a rail tab's inactive glyph: the filename stem,
 * the first `length` characters; the cell uppercases it.
 *
 * A leading dot is part of the name, not an extension separator — a
 * dotfile's own extension (a second dot further in) still drops, but the
 * leading dot itself survives into the glyph: `entityTabGlyph(".gitignore")`
 * is `".gi"`, not `""`.
 */
export const entityTabGlyph = (name: string, length = 3): string => {
  const leadingDot = name.startsWith(".") ? "." : "";
  const rest = leadingDot === "" ? name : name.slice(1);
  const dot = rest.lastIndexOf(".");
  const stem = dot === -1 ? rest : rest.slice(0, dot);
  return (leadingDot + stem).slice(0, length);
};
