import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BookOpenCheckIcon,
  DatabaseIcon,
  PlugIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";
import { BidiText } from "@stll/ui/components/bidi-text";
import { DirectionalIcon } from "@stll/ui/components/directional-icon";

import { CostBadge, SetupBadge } from "@/components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";

type ToolCatalogueCardProps = {
  entry: LoadedCatalogueEntry;
};

export const ToolCatalogueCard = ({ entry }: ToolCatalogueCardProps) => {
  const t = useTranslations();
  const labelKey = nativeToolLabelKey({ slug: entry.slug, kind: entry.kind });
  const displayName = labelKey ? t(labelKey) : entry.displayName;
  const isFirstParty = entry.author === "stella";
  const isIncluded = entry.kind === "native-tool" && entry.pinned;

  return (
    <Link
      className="bg-background group hover:bg-muted/25 flex min-h-32 cursor-pointer items-start gap-4 rounded-xl p-4 text-start shadow-[0_1px_2px_rgb(0_0_0/0.035),0_7px_22px_rgb(0_0_0/0.04)] transition-transform duration-150 hover:-translate-y-px"
      from="/tools/"
      params={{ slug: entry.slug }}
      to="/tools/$slug"
    >
      <PublicToolIcon entry={entry} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-7 items-start gap-2">
          <BidiText as="span" className="text-sm font-medium">
            {displayName}
          </BidiText>
          <DirectionalIcon
            className="text-muted-foreground ms-auto shrink-0 transition-opacity group-hover:opacity-70"
            icon={ArrowRightIcon}
          />
        </div>
        {entry.description.length > 0 && (
          <BidiText
            as="p"
            className="text-muted-foreground mt-1.5 line-clamp-2 text-xs leading-5"
          >
            {entry.description}
          </BidiText>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
          {isIncluded ? (
            <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs font-medium">
              {t("publicTools.discovery.includedBadge")}
            </span>
          ) : (
            <>
              <CostBadge cost={entry.cost} />
              <SetupBadge setup={entry.setup} />
            </>
          )}
          {!isFirstParty && entry.author.length > 0 && (
            <BidiText as="span" className="text-muted-foreground text-xs">
              {t("catalogue.by", { author: entry.author })}
            </BidiText>
          )}
          {entry.jurisdictions.length > 0 && (
            <div className="ms-auto flex flex-wrap items-center gap-1.5">
              {entry.jurisdictions.map((code) => (
                <span
                  className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-xs"
                  key={code}
                >
                  <bdi>{code}</bdi>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
};

const DISTINCT_BUILT_IN_ICONS = [
  "anonymize",
  "create-docx",
  "web-search",
] as const;

function PublicToolIcon({ entry }: { entry: LoadedCatalogueEntry }) {
  const hasCatalogueIcon =
    entry.icon !== null ||
    entry.iconUrl !== undefined ||
    DISTINCT_BUILT_IN_ICONS.some((slug) => slug === entry.slug);

  if (hasCatalogueIcon) {
    return (
      <div className="bg-muted/45 flex size-10 shrink-0 items-center justify-center rounded-lg">
        <CatalogueEntryIcon
          className="text-muted-foreground"
          icon={entry.icon}
          iconUrl={entry.iconUrl ?? null}
          size={24}
          slug={entry.slug}
        />
      </div>
    );
  }

  let Icon = DatabaseIcon;
  if (entry.kind === "skill") {
    Icon = BookOpenCheckIcon;
  } else if (entry.kind === "mcp") {
    Icon = PlugIcon;
  }

  return (
    <div className="bg-muted/45 flex size-10 shrink-0 items-center justify-center rounded-lg">
      <Icon className="text-muted-foreground size-5" />
    </div>
  );
}
