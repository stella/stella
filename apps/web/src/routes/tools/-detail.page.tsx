import { lazy, Suspense } from "react";

import { ClientOnly, getRouteApi } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

import {
  CostBadge,
  FirstPartyMark,
  LicenseBadge,
  SetupBadge,
} from "@/components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import {
  nativeToolDescriptionKey,
  nativeToolLabelKey,
} from "@/components/catalogue/native-tool-label";
import {
  DownloadAffordance,
  InstallButtonPlaceholder,
  ToolContent,
} from "@/features/knowledge/public/tools/public-tool-content";
import { getAnalytics } from "@/lib/analytics/provider";
import { PRACTICE_AREA_LABEL_KEY } from "@/lib/tools-catalogue";
import { PublicToolDetailShell } from "@/routes/tools/-detail.pending";

const detailRoute = getRouteApi("/tools/$slug");

const AddToStella = lazy(async () => ({
  default: (await import("@/features/knowledge/public/tools/add-to-stella"))
    .AddToStella,
}));

export function PublicToolDetail() {
  const t = useTranslations();
  const { entry, markdown } = detailRoute.useLoaderData();
  const installIntent = detailRoute.useSearch({
    select: (s) => s.install === "1",
  });
  const navigate = detailRoute.useNavigate();
  const labelKey = nativeToolLabelKey({ slug: entry.slug, kind: entry.kind });
  const displayName = labelKey ? t(labelKey) : entry.displayName;
  const descriptionKey = nativeToolDescriptionKey({
    slug: entry.slug,
    kind: entry.kind,
  });
  const homepage = entry.homepage ? sanitizeHref(entry.homepage) : undefined;

  return (
    <PublicToolDetailShell
      headerIcon={
        <CatalogueEntryIcon
          className="mt-0.5 shrink-0"
          icon={entry.icon}
          iconUrl={entry.iconUrl ?? null}
          size={32}
          slug={entry.slug}
          tone="muted"
        />
      }
      title={displayName}
      firstPartyMark={entry.author === "stella" && <FirstPartyMark />}
      author={t("catalogue.by", { author: entry.author })}
      description={descriptionKey ? t(descriptionKey) : entry.description}
      badges={
        <>
          <CostBadge cost={entry.cost} />
          <SetupBadge setup={entry.setup} />
          <LicenseBadge license={entry.license} />
          {entry.jurisdictions.map((code) => (
            <span
              className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-xs"
              key={code}
            >
              <bdi>{code}</bdi>
            </span>
          ))}
        </>
      }
      tags={entry.tags.map((tag) => (
        <span
          className="border-border text-muted-foreground inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs"
          key={tag}
        >
          <bdi>{t(PRACTICE_AREA_LABEL_KEY[tag])}</bdi>
        </span>
      ))}
      actions={
        <>
          <ClientOnly fallback={<InstallButtonPlaceholder />}>
            <Suspense fallback={<InstallButtonPlaceholder />}>
              <AddToStella
                displayName={displayName}
                entry={entry}
                installIntent={installIntent}
                onClearInstallIntent={() => {
                  navigate({ replace: true, search: {} }).catch(
                    (error: unknown) => {
                      getAnalytics().captureError(error, {
                        fingerprintKey: "PublicToolDetail:failure",
                        scope: {
                          type: "handler",
                          handlerId: "PublicToolDetail:failure",
                        },
                      });
                    },
                  );
                }}
              />
            </Suspense>
          </ClientOnly>
          <DownloadAffordance entry={entry} />
          {homepage && (
            <a
              className="text-primary text-sm hover:underline"
              href={sanitizeHref(homepage)}
              rel="noreferrer"
              target="_blank"
            >
              {t("catalogue.openHomepage")}
            </a>
          )}
        </>
      }
    >
      <ToolContent entry={entry} markdown={markdown} />
    </PublicToolDetailShell>
  );
}
