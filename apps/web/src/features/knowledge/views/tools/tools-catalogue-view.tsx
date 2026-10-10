import type { ReactElement, ReactNode } from "react";
import { useState } from "react";

import { useTranslations } from "use-intl";

import { EU_MEMBER_STATES } from "@stll/catalogue";
import { compareByLocale } from "@stll/collation";
import { Button } from "@stll/ui/button";
import {
  CheckIcon,
  ChevronDownIcon,
  GlobeIcon,
  SearchIcon,
  XIcon,
} from "@stll/ui/icons";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@stll/ui/input-group";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";
import { McpIcon } from "@/components/mcp-icon";
import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@/components/responsive-action-toolbar";
import type {
  KnowledgeTool,
  ToolsSource,
} from "@/features/knowledge/views/tools/tools-seam";
import { useLocale } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import type { PracticeJurisdiction } from "@/lib/jurisdictions";

const FILTERS = ["all", "skill", "mcp"] as const;

export type ToolsCatalogueKind = (typeof FILTERS)[number];

const KIND_LABEL_KEY = {
  all: "common.all",
  skill: "catalogue.filter.skills",
  mcp: "catalogue.filter.mcps",
} as const satisfies Record<ToolsCatalogueKind, TranslationKey>;

type ToolsCatalogueViewProps<TTool extends KnowledgeTool> = {
  source: ToolsSource<TTool>;
  /** Initial kind filter (e.g. from `?kind=mcp`). */
  initialKind?: ToolsCatalogueKind | undefined;
  /**
   * Seeds the jurisdiction filter so a CZ-based user sees only CZ + EU
   * entries by default. Universal entries (no jurisdictions) always pass.
   */
  practiceJurisdictions?: readonly PracticeJurisdiction[] | undefined;
  /** Renders one entry, normally a `CatalogueRow` with the route's actions. */
  renderEntry: (tool: TTool) => ReactElement;
  /** A control at the end of the toolbar, e.g. adding a custom tool. */
  addAction?: ReactElement | undefined;
  /** A control beside the "Recommended" heading, given the tools in view. */
  recommendedAction?: ((tools: readonly TTool[]) => ReactNode) | undefined;
  /** Replaces the empty list when the connector filter finds none at all. */
  mcpEmptyAction?: ReactNode;
  /** Dialogs and sheets the route owns. */
  children?: ReactNode;
};

/** Pre-populate from the practice countries, plus "EU" when one of them is an
 *  EU-27 member. Mirrors the onboarding catalogue step. */
const initialJurisdictions = (
  practiceJurisdictions: readonly PracticeJurisdiction[] | undefined,
): Set<string> => {
  const initial = new Set<string>();
  if (!practiceJurisdictions) {
    return initial;
  }
  let touchesEu = false;
  for (const jurisdiction of practiceJurisdictions) {
    const code = jurisdiction.countryCode.toUpperCase();
    initial.add(code);
    if (EU_MEMBER_STATES.has(code)) {
      touchesEu = true;
    }
  }
  if (touchesEu) {
    initial.add("EU");
  }
  return initial;
};

export const ToolsCatalogueView = <TTool extends KnowledgeTool>({
  source,
  initialKind,
  practiceJurisdictions,
  renderEntry,
  addAction,
  recommendedAction,
  mcpEmptyAction,
  children,
}: ToolsCatalogueViewProps<TTool>) => {
  const t = useTranslations();
  const locale = useLocale();
  const [filter, setFilter] = useState<ToolsCatalogueKind>(
    initialKind ?? "all",
  );
  const [query, setQuery] = useState("");
  const [jurisdictionFilter, setJurisdictionFilter] = useState<Set<string>>(
    () => initialJurisdictions(practiceJurisdictions),
  );
  const [jurisdictionQuery, setJurisdictionQuery] = useState("");

  const entries = source.entries;

  const filtered = (() => {
    const normalised = query.trim().toLowerCase();
    const localizedName = (entry: TTool) => {
      const key = nativeToolLabelKey({ slug: entry.slug, kind: entry.kind });
      return key ? t(key) : entry.displayName;
    };
    const subset = entries.filter((entry) => {
      if (filter !== "all" && entry.kind !== filter) {
        return false;
      }
      if (
        jurisdictionFilter.size > 0 &&
        entry.jurisdictions.length > 0 &&
        !entry.jurisdictions.some((code) => jurisdictionFilter.has(code))
      ) {
        return false;
      }
      if (normalised === "") {
        return true;
      }
      return (
        entry.displayName.toLowerCase().includes(normalised) ||
        localizedName(entry).toLowerCase().includes(normalised) ||
        entry.description.toLowerCase().includes(normalised) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(normalised))
      );
    });
    const compareName = compareByLocale(locale);
    return [...subset].toSorted((left, right) => {
      if (left.isRecommendedForOrg !== right.isRecommendedForOrg) {
        return left.isRecommendedForOrg ? -1 : 1;
      }
      return compareName(localizedName(left), localizedName(right));
    });
  })();

  const allJurisdictionCodes = (() => {
    const set = new Set<string>();
    for (const entry of entries) {
      for (const code of entry.jurisdictions) {
        set.add(code);
      }
    }
    return [...set].toSorted();
  })();

  const recommendedFiltered = filtered.filter(
    (entry) => entry.isRecommendedForOrg === true,
  );
  const otherFiltered = filtered.filter(
    (entry) => entry.isRecommendedForOrg !== true,
  );
  // "Others" only reads as such next to a ranking; a source that ranks
  // nothing lists its tools without the heading.
  const ranksTools = entries.some(
    (entry) => entry.isRecommendedForOrg !== undefined,
  );
  const hasMcpEntries = entries.some((entry) => entry.kind === "mcp");
  // On a truly empty MCP catalogue, replace the generic "no entries" + reset
  // line with a prominent add-MCP call to action, when the route offers one.
  const showMcpEmptyCta =
    filter === "mcp" && !hasMcpEntries && mcpEmptyAction !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <ResponsiveActionToolbar>
        <ResponsiveActionToolbarItem slot="primary">
          <InputGroup className="min-h-11 sm:min-h-0">
            <InputGroupInput
              className="max-sm:h-11 max-sm:leading-11"
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("onboarding.catalogueSearchPlaceholder")}
              type="search"
              value={query}
            />
            {query.length > 0 && (
              <InputGroupAddon align="inline-end">
                <Button
                  aria-label={t("onboarding.catalogueClearSearch")}
                  onClick={() => setQuery("")}
                  size="icon-xs"
                  type="button"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
        </ResponsiveActionToolbarItem>

        <ResponsiveActionToolbarItem slot="secondary">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  className="h-11 w-full justify-start sm:h-8 sm:w-auto"
                  type="button"
                  variant="outline"
                />
              }
            >
              <GlobeIcon className="size-3.5" />
              <span className="min-w-0 truncate">
                {jurisdictionFilter.size === 0
                  ? t("common.all")
                  : [...jurisdictionFilter].toSorted().join(", ")}
              </span>
              <ChevronDownIcon className="size-3.5" />
            </PopoverTrigger>
            <PopoverPopup align="end" className="w-60" side="bottom">
              <div className="border-border border-b p-2">
                <InputGroup>
                  <InputGroupAddon>
                    <SearchIcon className="text-muted-foreground" />
                  </InputGroupAddon>
                  <InputGroupInput
                    autoFocus
                    onChange={(e) => setJurisdictionQuery(e.target.value)}
                    placeholder={t("common.search")}
                    size="sm"
                    value={jurisdictionQuery}
                  />
                </InputGroup>
              </div>
              <div className="flex max-h-[260px] flex-col overflow-y-auto p-1">
                {jurisdictionQuery.trim() === "" && (
                  <>
                    <button
                      aria-pressed={jurisdictionFilter.size === 0}
                      className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
                      onClick={() => setJurisdictionFilter(new Set())}
                      type="button"
                    >
                      <span
                        className={cn(
                          "border-border flex size-4 items-center justify-center rounded-sm border",
                          jurisdictionFilter.size === 0 &&
                            "border-foreground bg-foreground",
                        )}
                      >
                        {jurisdictionFilter.size === 0 && (
                          <CheckIcon className="text-background size-3" />
                        )}
                      </span>
                      <span className="text-foreground font-medium">
                        {t("common.all")}
                      </span>
                    </button>
                    <div className="bg-border my-1 h-px" />
                  </>
                )}
                {(() => {
                  const matches = allJurisdictionCodes.filter((code) =>
                    code
                      .toLowerCase()
                      .includes(jurisdictionQuery.trim().toLowerCase()),
                  );
                  if (matches.length === 0) {
                    return (
                      <p className="text-muted-foreground px-2 py-3 text-center text-xs">
                        {t("common.noResults")}
                      </p>
                    );
                  }
                  return matches.map((code) => {
                    const active = jurisdictionFilter.has(code);
                    return (
                      <button
                        aria-pressed={active}
                        className="hover:bg-muted flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
                        key={code}
                        onClick={() =>
                          setJurisdictionFilter((prev) => {
                            const next = new Set(prev);
                            if (next.has(code)) {
                              next.delete(code);
                            } else {
                              next.add(code);
                            }
                            return next;
                          })
                        }
                        type="button"
                      >
                        <span
                          className={cn(
                            "border-border flex size-4 items-center justify-center rounded-sm border",
                            active && "border-foreground bg-foreground",
                          )}
                        >
                          {active && (
                            <CheckIcon className="text-background size-3" />
                          )}
                        </span>
                        <span className="text-foreground">{code}</span>
                      </button>
                    );
                  });
                })()}
              </div>
            </PopoverPopup>
          </Popover>
        </ResponsiveActionToolbarItem>

        {addAction !== undefined && (
          <ResponsiveActionToolbarItem
            className="ms-auto sm:ms-0"
            slot="action"
          >
            {addAction}
          </ResponsiveActionToolbarItem>
        )}
      </ResponsiveActionToolbar>

      {jurisdictionFilter.size > 0 && (
        <p className="text-muted-foreground -mt-3 text-xs">
          {t("catalogue.filterHint", {
            codes: [...jurisdictionFilter].toSorted().join(", "),
          })}{" "}
          <button
            className="hover:text-foreground underline underline-offset-2"
            onClick={() => setJurisdictionFilter(new Set())}
            type="button"
          >
            {t("common.showAll")}
          </button>
        </p>
      )}

      <div className="flex items-center gap-1.5">
        {FILTERS.map((option) => (
          <button
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium",
              filter === option
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted",
            )}
            key={option}
            onClick={() => setFilter(option)}
            type="button"
          >
            {t(KIND_LABEL_KEY[option])}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        {filtered.length === 0 && !showMcpEmptyCta && (
          <p className="text-muted-foreground text-sm">
            {t("catalogue.empty")}
          </p>
        )}
        {showMcpEmptyCta && (
          <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <McpIcon className="text-muted-foreground size-8" />
            {mcpEmptyAction}
          </div>
        )}
        {recommendedFiltered.length > 0 && (
          <>
            <div className="mb-1 flex items-center justify-between gap-3">
              <h2 className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
                {t("common.recommended")}
              </h2>
              {recommendedAction?.(recommendedFiltered)}
            </div>
            {recommendedFiltered.map((entry) => renderEntry(entry))}
          </>
        )}
        {otherFiltered.length > 0 && ranksTools && (
          <h2
            className={cn(
              "text-muted-foreground mb-1 text-xs font-medium tracking-wider uppercase",
              recommendedFiltered.length > 0 && "mt-4",
            )}
          >
            {t("catalogue.sectionOthers")}
          </h2>
        )}
        {otherFiltered.map((entry) => renderEntry(entry))}
        {/* Reset-all live at the bottom of the list whenever a
            filter is hiding entries. Always there, regardless of
            whether the filtered subset is empty or partial — the
            user's question is the same: "where's the rest?". */}
        {entries.length - filtered.length > 0 && !showMcpEmptyCta && (
          <div className="flex justify-center pt-2">
            <Button
              onClick={() => {
                setQuery("");
                setJurisdictionFilter(new Set());
                setFilter("all");
              }}
              size="sm"
              type="button"
              variant="link"
            >
              {t("common.showAll")} ({entries.length - filtered.length})
            </Button>
          </div>
        )}
      </div>

      {children}
    </div>
  );
};
