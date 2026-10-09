import { lazy, Suspense } from "react";

import {
  ClientOnly,
  createFileRoute,
  Link,
  notFound,
} from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";

import {
  CostBadge,
  FirstPartyMark,
  LicenseBadge,
  SetupBadge,
} from "@/components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";
import {
  DownloadAffordance,
  InstallButtonPlaceholder,
  ToolContent,
} from "@/features/knowledge/public/tools/public-tool-content";
import { getAnalytics } from "@/lib/analytics/provider";
import { publicToolPath } from "@/lib/knowledge/public-tools-path";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicToolsCanonicalUrl,
  createPublicToolsHead,
  createToolEntryJsonLd,
} from "@/lib/public-tools-seo";
import { PRACTICE_AREA_LABEL_KEY } from "@/lib/tools-catalogue";

const AddToStella = lazy(async () => ({
  default: (await import("@/features/knowledge/public/tools/add-to-stella"))
    .AddToStella,
}));

// Public SEO page: a bad `?install=` value (e.g. `?install=true`) must
// degrade to "no install intent", not throw into the router's default
// error boundary. `v.fallback` swallows the parse failure and yields
// `undefined`, rendering the page as if the param were absent.
const searchSchema = v.object({
  install: v.fallback(v.optional(v.literal("1")), undefined),
});

// Goes once the Knowledge flag is permanent (see ./route.tsx).
export const Route = createFileRoute("/tools/$slug")({
  validateSearch: searchSchema,
  loader: async ({ params }) => {
    const { loadPublicToolDetail } = await import("@/lib/public-tools-data");
    const detail = await loadPublicToolDetail(params.slug);
    if (!detail) {
      throw notFound();
    }
    return detail;
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {};
    }
    const { entry } = loaderData;
    const path = publicToolPath(entry.slug);
    return createPublicToolsHead({
      description: entry.description,
      jsonLd: createToolEntryJsonLd({
        author: entry.author,
        authorUrl: entry.authorUrl,
        canonicalUrl: createPublicToolsCanonicalUrl(path),
        cost: entry.cost,
        description: entry.description,
        homepage: entry.homepage,
        kind: entry.kind,
        license: entry.license,
        name: entry.displayName,
      }),
      path,
      title: pageTitleLiteral(entry.displayName),
      type: "article",
    });
  },
  notFoundComponent: PublicToolNotFound,
  component: PublicToolDetail,
});

function PublicToolDetail() {
  const t = useTranslations();
  const { entry, markdown } = Route.useLoaderData();
  const installIntent = Route.useSearch({ select: (s) => s.install === "1" });
  const navigate = Route.useNavigate();
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
              <bdi>{code}</bdi>
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
                <bdi>{t(PRACTICE_AREA_LABEL_KEY[tag])}</bdi>
              </span>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <ClientOnly fallback={<InstallButtonPlaceholder />}>
            <Suspense fallback={<InstallButtonPlaceholder />}>
              <AddToStella
                displayName={displayName}
                entry={entry}
                installIntent={installIntent}
                onClearInstallIntent={() => {
                  navigate({ replace: true, search: {} }).catch(
                    (error: unknown) => {
                      getAnalytics().captureError(error);
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
        </div>

        <div className="border-border mt-2 border-t pt-4">
          <ToolContent entry={entry} markdown={markdown} />
        </div>
      </div>
    </main>
  );
}

function PublicToolNotFound() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground text-sm">
        {t("publicTools.notFound")}
      </p>
      <Button render={<Link from="/tools/$slug" to="/tools" />}>
        {t("common.back")}
      </Button>
    </main>
  );
}
