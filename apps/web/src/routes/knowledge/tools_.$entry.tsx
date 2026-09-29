import { lazy, Suspense } from "react";

import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";

import { getAnalytics } from "@/lib/analytics/provider";
import { resolveToolEntry } from "@/lib/knowledge/tool-entry";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  isPublicKnowledgeCrawlAllowed,
  isPublicKnowledgeEnabled,
} from "@/lib/public-knowledge-launch";
import { publicToolPath } from "@/lib/public-tools-path";
import {
  createPublicToolsCanonicalUrl,
  createPublicToolsHead,
  createToolEntryJsonLd,
} from "@/lib/public-tools-seo";
import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { PublicToolDetail } from "@/routes/knowledge/-public/public-tool-detail";

const LazyMemberSkillEditorPage = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-member/member-skill-editor-page");
  return { default: module.MemberSkillEditorPage };
});

// A bad `?install=` value degrades to "no install intent" rather than
// throwing into the router's error boundary.
const searchSchema = v.object({
  install: v.fallback(v.optional(v.literal("1")), undefined),
});

/**
 * One address for two kinds of page: an organization's skill (by its UUID)
 * or a published tool (by its slug). The entry is resolved before anything is
 * read, so a skill id is never looked up in the catalogue and a slug never
 * opens the skill editor.
 */
export const Route = createFileRoute("/knowledge/tools_/$entry")({
  validateSearch: searchSchema,
  loader: async ({ params }) => {
    const page = await resolveToolEntry(params.entry, {
      catalogueServed: isPublicKnowledgeEnabled(),
      loadCatalogueDetail: async (slug) => {
        const { loadPublicToolDetail } =
          await import("@/lib/public-tools-data");
        return await loadPublicToolDetail(slug);
      },
    });
    switch (page.page) {
      case "missing":
        throw notFound();
      case "skill":
        return page;
      case "catalogue":
        return {
          page: page.page,
          displayName: page.detail.displayName,
          entry: page.detail.entry,
          markdown: page.detail.markdown,
        };
      default: {
        page satisfies never;
        return panic(`Unhandled tool entry: ${String(page)}`);
      }
    }
  },
  head: ({ loaderData }) => {
    if (loaderData?.page !== "catalogue") {
      return {};
    }
    const { entry } = loaderData;
    const path = publicToolPath(entry.slug);
    return createPublicToolsHead({
      crawlAllowed: isPublicKnowledgeCrawlAllowed(),
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
  notFoundComponent: ToolEntryNotFound,
  component: ToolEntryPage,
});

function ToolEntryPage() {
  const page = Route.useLoaderData();
  const installIntent = Route.useSearch({ select: (s) => s.install === "1" });
  const navigate = Route.useNavigate();

  if (page.page === "catalogue") {
    return (
      <PublicToolDetail
        entry={page.entry}
        installIntent={installIntent}
        markdown={page.markdown}
        onClearInstallIntent={() => {
          navigate({ replace: true, search: {} }).catch((error: unknown) => {
            getAnalytics().captureError(error);
          });
        }}
      />
    );
  }

  // A skill belongs to an organization: without an account there is nothing
  // to show, and nothing is asked for.
  return (
    <KnowledgeAudienceGate
      anonymous={() => <ToolEntryNotFound />}
      checking={null}
      member={(organizationId) => (
        <Suspense fallback={null}>
          <LazyMemberSkillEditorPage
            organizationId={organizationId}
            skillId={page.skillId}
          />
        </Suspense>
      )}
    />
  );
}

function ToolEntryNotFound() {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-muted-foreground text-sm">
        {t("publicTools.notFound")}
      </p>
      <Button render={<Link to="/knowledge/tools" />}>
        {t("common.back")}
      </Button>
    </main>
  );
}
