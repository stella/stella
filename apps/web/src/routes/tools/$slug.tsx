import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { loadCatalogue } from "@stll/catalogue";

import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";
import { pageTitleLiteral } from "@/lib/page-title";
import { createPublicToolsHead } from "@/lib/public-tools-seo";
import { sanitizeHref } from "@/lib/sanitize-href";
import {
  CostBadge,
  FirstPartyMark,
  LicenseBadge,
  SetupBadge,
} from "@/routes/_protected.knowledge/-components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/routes/_protected.knowledge/-components/catalogue/catalogue-entry-icon";
import { prettifyPracticeArea } from "@/routes/tools/-components/tools-catalogue.logic";

// Slugs are unique across kinds, so a flat lookup is unambiguous.
const findEntryBySlug = (slug: string) =>
  loadCatalogue().find((entry) => entry.slug === slug);

export const Route = createFileRoute("/tools/$slug")({
  loader: ({ params }) => {
    const entry = findEntryBySlug(params.slug);
    if (!entry) {
      throw redirect({ to: "/tools", replace: true });
    }
    return entry;
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {};
    }
    return createPublicToolsHead({
      description: loaderData.description,
      path: `/tools/${loaderData.slug}`,
      title: pageTitleLiteral(loaderData.displayName),
      type: "article",
    });
  },
  component: PublicToolDetail,
});

function PublicToolDetail() {
  const t = useTranslations();
  const entry = Route.useLoaderData();
  const labelKey = nativeToolLabelKey({ slug: entry.slug, kind: entry.kind });
  const displayName = labelKey ? t(labelKey) : entry.displayName;
  const homepage = entry.homepage ? sanitizeHref(entry.homepage) : undefined;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
        <div className="flex items-start gap-3">
          <CatalogueEntryIcon
            className="text-muted-foreground mt-0.5 shrink-0"
            icon={entry.icon}
            iconUrl={entry.iconUrl ?? null}
            size={32}
            slug={entry.slug}
          />
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold" dir="auto">
                {displayName}
              </h1>
              {entry.author === "stella" && <FirstPartyMark />}
            </div>
            <p className="text-muted-foreground text-sm">
              {t("catalogue.by", { author: entry.author })}
            </p>
          </div>
        </div>

        <p className="text-foreground text-sm" dir="auto">
          {entry.description}
        </p>

        <div className="flex flex-wrap items-center gap-1.5">
          <CostBadge cost={entry.cost} />
          <SetupBadge setup={entry.setup} />
          <LicenseBadge license={entry.license} />
          {entry.jurisdictions.map((code) => (
            <span
              className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-1.5 py-0.5 text-xs"
              key={code}
            >
              {code}
            </span>
          ))}
        </div>

        {entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {entry.tags.map((tag) => (
              <span
                className="border-border text-muted-foreground inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs"
                key={tag}
              >
                {prettifyPracticeArea(tag)}
              </span>
            ))}
          </div>
        )}

        {homepage && (
          <a
            className="text-primary text-sm hover:underline"
            href={homepage}
            rel="noreferrer"
            target="_blank"
          >
            {t("catalogue.openHomepage")}
          </a>
        )}

        <p className="text-muted-foreground border-border mt-2 border-t pt-4 text-xs">
          {t("publicTools.detailComingSoon")}
        </p>
      </div>
    </main>
  );
}
