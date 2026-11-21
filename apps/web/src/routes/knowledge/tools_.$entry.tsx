import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { panic } from "better-result";
import * as v from "valibot";

import { KNOWLEDGE_CATALOGUE_PATHS } from "@/lib/knowledge/knowledge-catalogues";
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
import { ToolEntryPage } from "@/routes/knowledge/-public/tool-entry.page";
import { ToolEntryPending } from "@/routes/knowledge/-public/tool-entry.pending";
import { ToolEntryNotFound } from "@/routes/knowledge/-tool-entry-not-found";

// A bad `?install=` value degrades to "no install intent" rather than
// throwing into the router's error boundary.
const searchSchema = routeSearchSchema({
  install: v.fallback(v.optional(v.literal("1")), undefined),
});

/**
 * A published tool, by its slug: the same page for every visitor. An
 * organization's skill has its own address; a skill id here, which this page
 * once served, is sent there for good. The entry is resolved before anything
 * is read, so a skill id is never looked up in the catalogue.
 */
export const Route = createFileRoute("/knowledge/tools_/$entry")({
  staticData: {
    presentation: routePresentation(
      { type: "knowledge-detail", detail: "tool" },
      {
        type: "label",
        labelKey: "knowledge.sections.tools.title",
        to: KNOWLEDGE_CATALOGUE_PATHS.tools,
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
        redirect({
          to: "/knowledge/tools/skills/$skillId",
          params: { skillId: page.skillId },
          replace: true,
          statusCode: 301,
          throw: true,
        });
        return panic("TanStack Router did not throw the skill redirect.");
      case "catalogue":
        return {
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
    if (loaderData === undefined) {
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
  pendingComponent: ToolEntryPending,
});
