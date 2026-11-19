import { lazy, Suspense } from "react";

import { createFileRoute, notFound } from "@tanstack/react-router";
import { panic } from "better-result";
import * as v from "valibot";

import { getAnalytics } from "@/lib/analytics/provider";
import {
  isPublicKnowledgeCrawlAllowed,
  isPublicKnowledgeEnabled,
} from "@/lib/knowledge/public-knowledge-launch";
import { publicToolPath } from "@/lib/knowledge/public-tools-path";
import { resolveToolEntry } from "@/lib/knowledge/tool-entry";
import { pageTitleLiteral } from "@/lib/page-title";
import {
  createPublicToolsCanonicalUrl,
  createPublicToolsHead,
  createToolEntryJsonLd,
} from "@/lib/public-tools-seo";
import { routeSearchSchema } from "@/route-search-params";
import { routePresentation } from "@/routes/-route-presentation";
import { KnowledgeAudienceGate } from "@/routes/knowledge/-knowledge-audience-gate";
import { PublicToolDetail } from "@/routes/knowledge/-public/public-tool-detail";
import { ToolEntryNotFound } from "@/routes/knowledge/-tool-entry-not-found";

const LazyMemberSkillEditorPage = lazy(async () => {
  const module =
    await import("@/routes/knowledge/-member/member-skill-editor-page");
  return { default: module.MemberSkillEditorPage };
});

// A bad `?install=` value degrades to "no install intent" rather than
// throwing into the router's error boundary.
const searchSchema = routeSearchSchema({
  install: v.fallback(v.optional(v.literal("1")), undefined),
});

/**
 * One address for two kinds of page: an organization's skill (by its UUID)
 * or a published tool (by its slug). The entry is resolved before anything is
 * read, so a skill id is never looked up in the catalogue and a slug never
 * opens the skill editor.
 */
export const Route = createFileRoute("/knowledge/tools_/$entry")({
  staticData: {
    presentation: routePresentation(
      {
        type: "knowledge-detail",
        detail: "skill",
      },
      {
        type: "label",
        labelKey: "knowledge.sections.tools.title",
        to: "/knowledge/tools",
      },
    ),
  },
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
        notFound({ throw: true });
        return panic("TanStack Router did not throw a not-found response.");
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
            getAnalytics().captureError(error, {
              fingerprintKey: "ToolEntryPage:failure",
              scope: { type: "handler", handlerId: "ToolEntryPage:failure" },
            });
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
