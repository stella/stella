import { useMemo, useState } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import type { TranslationKey } from "@/i18n/types";
import { catalogueOptions } from "@/routes/_protected.settings/-queries/catalogue";

import { CatalogueEntryCard } from "./catalogue-entry-card";
import type { CatalogueKind } from "./catalogue-types";
import { InstallPackButton } from "./install-pack-button";

type FilterKind = CatalogueKind | "all";

const KIND_LABEL_KEY = {
  all: "catalogue.filter.all",
  skill: "catalogue.filter.skills",
  mcp: "catalogue.filter.mcps",
  "native-tool": "catalogue.filter.nativeTools",
} as const satisfies Record<FilterKind, TranslationKey>;

const FILTERS: readonly FilterKind[] = ["all", "skill", "mcp", "native-tool"];

type CatalogueBrowserProps = {
  organizationId: string;
  mode: "onboarding" | "settings";
};

export const CatalogueBrowser = ({
  organizationId,
  mode,
}: CatalogueBrowserProps) => {
  const t = useTranslations();
  const { data } = useSuspenseQuery(catalogueOptions(organizationId));
  const [filter, setFilter] = useState<FilterKind>("all");

  const entries = data.entries;

  const recommended = useMemo(
    () => entries.filter((entry) => entry.isRecommendedForOrg),
    [entries],
  );

  const filtered = useMemo(() => {
    const subset =
      filter === "all"
        ? entries
        : entries.filter((entry) => entry.kind === filter);
    return [...subset].sort((left, right) => {
      if (left.isRecommendedForOrg !== right.isRecommendedForOrg) {
        return left.isRecommendedForOrg ? -1 : 1;
      }
      return left.displayName.localeCompare(right.displayName);
    });
  }, [entries, filter]);

  return (
    <div className="flex flex-col gap-6">
      {recommended.length > 0 && (
        <div className="bg-muted/40 border-border flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">
              {mode === "onboarding"
                ? t("catalogue.onboarding.packTitle")
                : t("catalogue.settings.packTitle")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("catalogue.packDescription", {
                count: recommended.length,
              })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {recommended.map((entry) => (
              <span
                className="bg-background border-border inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                key={`${entry.kind}-${entry.slug}`}
              >
                {entry.displayName}
              </span>
            ))}
          </div>
          <div>
            <InstallPackButton
              entries={recommended}
              organizationId={organizationId}
            />
          </div>
        </div>
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

      {filtered.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("catalogue.empty")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((entry) => (
            <CatalogueEntryCard
              entry={entry}
              key={`${entry.kind}-${entry.slug}`}
              organizationId={organizationId}
            />
          ))}
        </div>
      )}
    </div>
  );
};
