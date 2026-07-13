import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";

import {
  CostBadge,
  FirstPartyMark,
  SetupBadge,
} from "@/components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";

type ToolCatalogueCardProps = {
  entry: LoadedCatalogueEntry;
  /** Jurisdiction codes recommending this entry, if any. */
  recommendedIn?: readonly string[] | undefined;
};

export const ToolCatalogueCard = ({
  entry,
  recommendedIn,
}: ToolCatalogueCardProps) => {
  const t = useTranslations();
  const labelKey = nativeToolLabelKey({ slug: entry.slug, kind: entry.kind });
  const displayName = labelKey ? t(labelKey) : entry.displayName;
  const isFirstParty = entry.author === "stella";

  return (
    <Link
      className="border-border hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-start transition-colors"
      params={{ slug: entry.slug }}
      to="/tools/$slug"
    >
      <CatalogueEntryIcon
        className="text-muted-foreground mt-0.5 shrink-0"
        icon={entry.icon}
        iconUrl={entry.iconUrl ?? null}
        size={24}
        slug={entry.slug}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-h-6 flex-wrap items-center gap-2">
          <span className="text-sm font-medium" dir="auto">
            {displayName}
          </span>
          {isFirstParty && <FirstPartyMark />}
          {recommendedIn && recommendedIn.length > 0 && (
            <span className="bg-success/12 text-success inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium">
              <span aria-hidden="true">
                {t("catalogue.sectionRecommended")}
              </span>
              <span className="sr-only">
                {t("publicTools.recommendedIn", {
                  codes: recommendedIn.join(", "),
                })}
              </span>
            </span>
          )}
        </div>
        {entry.description.length > 0 && (
          <p className="text-muted-foreground line-clamp-2 text-xs" dir="auto">
            {entry.description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <CostBadge cost={entry.cost} />
          <SetupBadge setup={entry.setup} />
          {entry.jurisdictions.length > 0 && (
            <div className="ms-auto flex flex-wrap items-center gap-1.5">
              {entry.jurisdictions.map((code) => (
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
    </Link>
  );
};
