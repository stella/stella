import { cn } from "../../lib/utils";
import type { FolioOutlineRailProps } from "../folio-ui";

/**
 * Built-in, dependency-light OutlineRail used when a consumer does not inject
 * one. Renders the outline as a plain semantic `<nav>` list of clickable
 * entries indented by level; clicking an entry calls `onJump` with the resolved
 * scroll container. Consumers inject the polished tick-rail + hover panel via
 * `DocxEditor`'s `components` prop.
 */
export function DefaultOutlineRail({
  items,
  scrollContainerRef,
  onJump,
  activeId,
  topOffset = 0,
  panelWidth = 300,
  ariaLabel = "Outline",
}: FolioOutlineRailProps) {
  if (items.length < 2) {
    return null;
  }

  return (
    <nav
      aria-label={ariaLabel}
      className="folio-default-outline-rail"
      style={{ top: topOffset, width: panelWidth }}
    >
      <ul className="folio-default-outline-list">
        {items.map((item) => {
          const isActive = item.id === activeId;
          return (
            <li key={item.id}>
              <button
                aria-current={isActive ? "true" : undefined}
                className={cn(
                  "folio-default-outline-item",
                  isActive && "folio-default-outline-item--active",
                )}
                onClick={() => {
                  const container = scrollContainerRef.current;
                  if (container) {
                    onJump(item.id, container);
                  }
                }}
                style={{ paddingInlineStart: `${item.level * 12 + 8}px` }}
                title={item.label}
                type="button"
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
