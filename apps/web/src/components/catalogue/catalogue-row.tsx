import { cn } from "@stll/ui/lib/utils";

import { ContextMenu, type ContextMenuAction } from "@/components/context-menu";
import {
  CostBadge,
  FirstPartyMark,
  SetupBadge,
} from "@/routes/_protected.knowledge/-components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-entry-icon";

/**
 * Minimal display fields shared by onboarding (`LoadedCatalogueEntry`)
 * and settings (`CatalogueEntry`). Callers map their domain entry into
 * this shape, then layer surface-specific action buttons via `actions`.
 */
export type CatalogueRowDisplay = {
  slug: string;
  displayName: string;
  description: string;
  author: string;
  cost: "free" | "paid" | null;
  setup: "none" | "account" | "api-key";
  icon: string | null;
  iconUrl?: string | null | undefined;
  jurisdictions: readonly string[];
};

type CatalogueRowProps = {
  display: CatalogueRowDisplay;
  focused: boolean;
  onFocus: () => void;
  /**
   * Right-aligned action area in the title row. Callers render their
   * Add/Remove/Install/Loading affordances here. Title row reserves a
   * button-sized min-height so swaps don't reflow neighbouring rows.
   */
  actions?: React.ReactNode;
  contextActions?: readonly ContextMenuAction[];
  /**
   * Optional decorative variant for the unfocused state (e.g. onboarding
   * uses a slightly highlighted background when an entry is "selected"
   * but not focused). Settings doesn't need this.
   */
  accentWhenUnfocused?: boolean;
};

export const CatalogueRow = ({
  display,
  focused,
  onFocus,
  actions,
  contextActions,
  accentWhenUnfocused = false,
}: CatalogueRowProps) => {
  const isFirstParty = display.author === "stella";

  return (
    <ContextMenu actions={contextActions ?? []}>
      <div
        aria-pressed={focused}
        className={cn(
          "flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-start transition-colors",
          focused && "border-foreground bg-accent/60 ring-foreground/20 ring-1",
          !focused &&
            accentWhenUnfocused &&
            "border-foreground-disabled bg-accent/20",
          !focused && !accentWhenUnfocused && "border-border hover:bg-muted/40",
        )}
        onClick={onFocus}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) {
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onFocus();
          }
        }}
        role="button"
        tabIndex={0}
      >
        <CatalogueEntryIcon
          className="text-muted-foreground mt-0.5 shrink-0"
          icon={display.icon}
          iconUrl={display.iconUrl ?? null}
          size={24}
          slug={display.slug}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
            <span className="text-sm font-medium">{display.displayName}</span>
            {isFirstParty && <FirstPartyMark />}
            <div className="ms-auto flex items-center gap-2">{actions}</div>
          </div>
          {display.description.length > 0 && (
            <p className="text-muted-foreground line-clamp-1 text-xs">
              {display.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <CostBadge cost={display.cost} />
            <SetupBadge setup={display.setup} />
            {display.jurisdictions.length > 0 && (
              <div className="ms-auto flex flex-wrap items-center gap-1.5">
                {display.jurisdictions.map((code) => (
                  <span
                    className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-xs"
                    key={code}
                  >
                    {code}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </ContextMenu>
  );
};
