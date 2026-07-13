import { lazy, Suspense } from "react";

import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  githubArchiveUrl,
  type LoadedCatalogueEntry,
  type LoadedEntryByKind,
} from "@stll/catalogue";
import { Button } from "@stll/ui/components/button";

import {
  CostBadge,
  FirstPartyMark,
  LicenseBadge,
  SetupBadge,
} from "@/components/catalogue/catalogue-badges";
import { CatalogueEntryIcon } from "@/components/catalogue/catalogue-entry-icon";
import { nativeToolLabelKey } from "@/components/catalogue/native-tool-label";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicToolsCanonicalUrl,
  createPublicToolsHead,
  createToolEntryJsonLd,
} from "@/lib/public-tools-seo";
import { sanitizeHref } from "@/lib/sanitize-href";
import { prettifyPracticeArea } from "@/lib/tools-catalogue";
import {
  buildMcpConfigSnippet,
  githubSkillTreeUrl,
  toolDownloadPath,
} from "@/routes/tools/-components/tool-detail.logic";

const ToolMarkdown = lazy(async () => ({
  default: (await import("@/routes/tools/-components/tool-markdown"))
    .ToolMarkdown,
}));

const CopyButton = lazy(async () => ({
  default: (await import("@/routes/tools/-components/copy-button")).CopyButton,
}));

const AddToStella = lazy(async () => ({
  default: (await import("@/routes/tools/-components/add-to-stella"))
    .AddToStella,
}));

// Public SEO page: a bad `?install=` value (e.g. `?install=true`) must
// degrade to "no install intent", not throw into the router's default
// error boundary. `v.fallback` swallows the parse failure and yields
// `undefined`, rendering the page as if the param were absent.
const searchSchema = v.object({
  install: v.fallback(v.optional(v.literal("1")), undefined),
});

export const Route = createFileRoute("/tools/$slug")({
  validateSearch: searchSchema,
  loader: async ({ params }) => {
    const { loadPublicToolDetail } = await import("@/lib/public-tools-data");
    const detail = await loadPublicToolDetail(params.slug);
    if (!detail) {
      throw redirect({ to: "/tools", replace: true });
    }
    return detail;
  },
  head: ({ loaderData }) => {
    if (!loaderData) {
      return {};
    }
    const { entry } = loaderData;
    const path = `/tools/${entry.slug}` as const;
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

        <div className="flex flex-wrap items-center gap-2">
          <Suspense fallback={<InstallButtonPlaceholder />}>
            <AddToStella
              displayName={displayName}
              entry={entry}
              installIntent={installIntent}
              onClearInstallIntent={() =>
                void navigate({ replace: true, search: {} })
              }
            />
          </Suspense>
          <DownloadAffordance entry={entry} />
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
        </div>

        <div className="border-border mt-2 border-t pt-4">
          <ToolContent entry={entry} markdown={markdown} />
        </div>
      </div>
    </main>
  );
}

function InstallButtonPlaceholder() {
  const t = useTranslations();
  return (
    <Button disabled type="button">
      {t("publicTools.addToStella")}
    </Button>
  );
}

function DownloadAffordance({ entry }: { entry: LoadedCatalogueEntry }) {
  const t = useTranslations();
  if (entry.kind !== "skill") {
    return null;
  }
  if (entry.source === "in-tree") {
    return (
      <Button
        render={
          <a
            aria-label={t("common.download")}
            href={toolDownloadPath(entry.slug)}
          />
        }
        variant="outline"
      >
        {t("common.download")}
      </Button>
    );
  }
  return (
    <Button
      render={
        <a
          aria-label={t("publicTools.downloadUpstream")}
          href={githubArchiveUrl(entry)}
          rel="noreferrer"
          target="_blank"
        />
      }
      variant="outline"
    >
      {t("publicTools.downloadUpstream")}
    </Button>
  );
}

function ToolContent({
  entry,
  markdown,
}: {
  entry: LoadedCatalogueEntry;
  markdown: string | null;
}) {
  const t = useTranslations();

  if (entry.kind === "mcp") {
    return <McpConfig entry={entry} />;
  }

  if (entry.kind === "native-tool") {
    return (
      <p className="text-muted-foreground text-sm">
        {t("publicTools.nativeToolInfo")}
      </p>
    );
  }

  if (markdown !== null) {
    return (
      <Suspense fallback={<ContentLoading />}>
        <ToolMarkdown markdown={markdown} />
      </Suspense>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-sm">
        {t("publicTools.contentUnavailable")}
      </p>
      {entry.source === "github" && (
        <a
          className="text-primary text-sm hover:underline"
          href={githubSkillTreeUrl(entry)}
          rel="noreferrer"
          target="_blank"
        >
          {t("publicTools.viewOnGithub")}
        </a>
      )}
    </div>
  );
}

function McpConfig({ entry }: { entry: LoadedEntryByKind<"mcp"> }) {
  const t = useTranslations();
  const snippet = buildMcpConfigSnippet({
    slug: entry.slug,
    url: entry.url,
    authType: entry.authType,
    oauthRequestedScopes: entry.oauthRequestedScopes,
  });

  return (
    <section
      aria-label={t("catalogue.configuration")}
      className="flex flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          {t("catalogue.configuration")}
        </h2>
        <Suspense fallback={null}>
          <CopyButton text={snippet} />
        </Suspense>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("publicTools.mcpConfigHint")}
      </p>
      <pre className="bg-muted/40 border-border overflow-x-auto rounded-md border p-3 font-mono text-xs">
        {snippet}
      </pre>
      <div className="flex flex-wrap gap-3">
        {entry.documentationUrl && (
          <a
            className="text-primary text-sm hover:underline"
            href={sanitizeHref(entry.documentationUrl)}
            rel="noreferrer"
            target="_blank"
          >
            {t("publicTools.documentation")}
          </a>
        )}
        {entry.tokenHelpUrl && (
          <a
            className="text-primary text-sm hover:underline"
            href={sanitizeHref(entry.tokenHelpUrl)}
            rel="noreferrer"
            target="_blank"
          >
            {t("publicTools.tokenHelp")}
          </a>
        )}
      </div>
    </section>
  );
}

function ContentLoading() {
  const t = useTranslations();
  return (
    <p className="text-muted-foreground text-sm">{t("publicTools.content")}</p>
  );
}
