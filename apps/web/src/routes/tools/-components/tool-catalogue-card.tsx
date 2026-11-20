import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import type { LoadedCatalogueEntry } from "@stll/catalogue";
import { BidiText } from "@stll/ui/bidi-text";
import { BookOpenCheckIcon, DatabaseIcon, PlugIcon } from "@stll/ui/icons";
import { TruncatedText } from "@stll/ui/truncated-text";
import { cn } from "@stll/ui/utils";

import { CostBadge, SetupBadge } from "@/components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import {
  nativeToolDescriptionKey,
  nativeToolLabelKey,
} from "@/components/catalogue/native-tool-label";
import { ToolCatalogueCardFace } from "@/routes/tools/-components/tool-catalogue-card.pending";

type ToolCatalogueCardProps = {
  entry: LoadedCatalogueEntry;
};

export const ToolCatalogueCard = ({ entry }: ToolCatalogueCardProps) => {
  const t = useTranslations();
  const labelKey = nativeToolLabelKey({ slug: entry.slug, kind: entry.kind });
  const displayName = labelKey ? t(labelKey) : entry.displayName;
  const descriptionKey = nativeToolDescriptionKey({
    slug: entry.slug,
    kind: entry.kind,
  });
  const description = descriptionKey ? t(descriptionKey) : entry.description;
  const isFirstParty = entry.author === "stella";
  const isIncluded = entry.kind === "native-tool" && entry.pinned;

  return (
    <ToolCatalogueCardFace
      icon={<PublicToolIcon entry={entry} />}
      render={({ children, className }) => (
        <Link
          className={cn(
            className,
            "hover:bg-muted/25 cursor-pointer transition-transform duration-150 hover:-translate-y-px",
          )}
          from="/tools/"
          params={{ slug: entry.slug }}
          to="/tools/$slug"
        >
          {children}
        </Link>
      )}
      title={
        <BidiText as="span" className="text-sm font-medium">
          {displayName}
        </BidiText>
      }
      description={
        description.length > 0 && (
          <TruncatedText
            className="text-muted-foreground mt-1.5 text-xs leading-5"
            lines={2}
            render={<BidiText as="p" />}
          >
            {description}
          </TruncatedText>
        )
      }
      badges={
        <>
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
        </>
      }
    />
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
          icon={entry.icon}
          iconUrl={entry.iconUrl ?? null}
          size={24}
          slug={entry.slug}
          tone="muted"
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
