import { CheckIcon, ExternalLinkIcon, LoaderIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { stellaToast } from "@stll/ui/components/toast";

import {
  FirstPartyBadge,
  LicenseBadge,
  CostBadge,
  SetupBadge,
  RecommendedBadge,
} from "./catalogue-badges";
import { CatalogueEntryIcon } from "./catalogue-entry-icon";
import type { CatalogueEntry } from "./catalogue-types";
import { useInstallEntry } from "./use-install-entry";

type CatalogueEntryCardProps = {
  entry: CatalogueEntry;
  organizationId: string;
};

export const CatalogueEntryCard = ({
  entry,
  organizationId,
}: CatalogueEntryCardProps) => {
  const t = useTranslations();
  const install = useInstallEntry(organizationId);

  const onInstall = () => {
    install.mutate(entry, {
      onSuccess: () => {
        stellaToast.add({
          title: t("catalogue.installed", { name: entry.displayName }),
          type: "success",
        });
      },
      onError: (error) => {
        stellaToast.add({
          title:
            error instanceof Error
              ? error.message
              : t("catalogue.installFailed"),
          type: "error",
        });
      },
    });
  };

  const installable = entry.installState === "available";

  const homepageUrl = entry.homepage ?? entry.authorUrl;
  const isFirstParty = entry.author === "stella";

  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          <CatalogueEntryIcon
            icon={entry.icon}
            iconUrl={entry.iconUrl ?? null}
            size={40}
            slug={entry.slug}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">
              {entry.displayName}
            </h3>
            {homepageUrl && (
              <a
                aria-label={t("catalogue.openHomepage")}
                className="text-muted-foreground hover:text-foreground"
                href={homepageUrl}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLinkIcon className="size-3.5" />
              </a>
            )}
          </div>
          <p className="text-muted-foreground line-clamp-2 text-xs">
            {entry.description}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {entry.jurisdictions.map((code) => (
          <span
            className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-xs"
            key={code}
          >
            {code}
          </span>
        ))}
        {entry.isRecommendedForOrg && <RecommendedBadge />}
        {isFirstParty && <FirstPartyBadge />}
        <CostBadge cost={entry.cost} />
        <SetupBadge setup={entry.setup} />
        <LicenseBadge license={entry.license} />
      </div>

      <div className="mt-auto flex items-center justify-between">
        <span className="text-muted-foreground text-xs">
          {t("catalogue.by", { author: entry.author })}
        </span>
        {entry.installState === "installed" && (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <CheckIcon className="size-3.5" />
            {t("catalogue.installedShort")}
          </span>
        )}
        {entry.installState === "unavailable" && (
          <span className="text-muted-foreground text-xs">
            {t("catalogue.unavailable")}
          </span>
        )}
        {installable && (
          <Button
            disabled={install.isPending}
            onClick={onInstall}
            size="sm"
            variant="outline"
          >
            {install.isPending && (
              <LoaderIcon className="size-3.5 animate-spin" />
            )}
            {t("catalogue.install")}
          </Button>
        )}
      </div>
    </div>
  );
};
