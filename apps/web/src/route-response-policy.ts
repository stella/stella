import { panic } from "better-result";

import { isPublicCrawlPath } from "@/public-crawl-policy";
import type { PublicCrawlOptions } from "@/public-crawl-policy";
import type { FileRouteTypes } from "@/routeTree.gen";

export type CacheClass =
  | "private-no-store"
  | "public-anonymous"
  | "public-indexable";

export const SSR_CACHE_CLASS_HEADER = "x-stella-cache-class";

export const ROUTE_CACHE_CLASSES = {
  "/": "private-no-store",
  "/auth": "private-no-store",
  "/knowledge": "private-no-store",
  "/law": "private-no-store",
  "/onboarding": "private-no-store",
  "/tools": "private-no-store",
  "/agent-claim": "private-no-store",
  "/consent": "private-no-store",
  "/dev": "private-no-store",
  "/robots.txt": "private-no-store",
  "/sitemap.xml": "public-anonymous",
  "/chat": "private-no-store",
  "/settings": "private-no-store",
  "/time": "private-no-store",
  "/auth/error": "private-no-store",
  "/auth/organization": "private-no-store",
  "/auth/otp": "private-no-store",
  "/auth/professional-use": "private-no-store",
  "/auth/two-factor": "private-no-store",
  "/knowledge/clauses": "private-no-store",
  "/knowledge/playbooks": "private-no-store",
  "/knowledge/styles": "private-no-store",
  "/knowledge/templates": "private-no-store",
  "/knowledge/tools": "public-indexable",
  "/knowledge/workflows": "private-no-store",
  "/law/coverage": "public-indexable",
  "/mcp/oauth-callback": "private-no-store",
  "/sitemaps/law.xml": "public-anonymous",
  "/sitemaps/tools.xml": "public-anonymous",
  "/tools/$slug": "public-indexable",
  "/tools/contribute": "public-indexable",
  "/auth/": "private-no-store",
  "/knowledge/": "private-no-store",
  "/law/": "public-indexable",
  "/tools/": "public-indexable",
  "/settings/organization": "private-no-store",
  "/workspaces/$workspaceId": "private-no-store",
  "/chat/$threadId": "private-no-store",
  "/chat/new": "private-no-store",
  "/contacts/$contactId": "private-no-store",
  "/contacts/import": "private-no-store",
  "/verify/$code": "private-no-store",
  "/auth/accept-invitation/$invitationId": "private-no-store",
  "/knowledge/templates/catalogue": "public-indexable",
  "/knowledge/templates/catalogue/": "public-indexable",
  "/knowledge/tools/$entry": "public-indexable",
  "/knowledge/tools/contribute": "public-indexable",
  "/sitemaps/law-statutes/{$country}.xml": "public-anonymous",
  "/tools/$slug/download": "public-anonymous",
  "/chat/": "private-no-store",
  "/contacts/": "private-no-store",
  "/inbox/": "private-no-store",
  "/settings/": "private-no-store",
  "/workspaces/": "private-no-store",
  "/law/cases/": "public-indexable",
  "/workspaces/$workspaceId/$viewId": "private-no-store",
  "/settings/account/beta": "private-no-store",
  "/settings/account/connections": "private-no-store",
  "/settings/account/desktop": "private-no-store",
  "/settings/account/memory": "private-no-store",
  "/settings/account/profile": "private-no-store",
  "/settings/organization/ai": "private-no-store",
  "/settings/organization/billing": "private-no-store",
  "/settings/organization/anonymization": "private-no-store",
  "/settings/organization/audit-logs": "private-no-store",
  "/settings/organization/catalogue": "private-no-store",
  "/settings/organization/document-types": "private-no-store",
  "/settings/organization/matter-numbering": "private-no-store",
  "/settings/organization/members": "private-no-store",
  "/settings/organization/number-series": "private-no-store",
  "/settings/organization/time-policy": "private-no-store",
  "/settings/organization/usage": "private-no-store",
  "/settings/organization/vat-rates": "private-no-store",
  "/workspaces/$workspaceId/expenses": "private-no-store",
  "/workspaces/$workspaceId/invoices": "private-no-store",
  "/workspaces/$workspaceId/lists": "private-no-store",
  "/workspaces/$workspaceId/timesheets": "private-no-store",
  "/workspaces/$workspaceId/workflows": "private-no-store",
  "/knowledge/company-formats/$registry/$companyId": "private-no-store",
  "/knowledge/tools/$entry/download": "public-anonymous",
  "/law/cases/research/$tableId": "private-no-store",
  "/sitemaps/law-statutes/$country/{$bucket}.xml": "public-anonymous",
  "/settings/organization/": "private-no-store",
  "/workspaces/$workspaceId/": "private-no-store",
  "/law/$country/statutes/": "public-indexable",
  "/law/cases/research/": "private-no-store",
  "/chat/workspaces/$workspaceId/$threadId": "private-no-store",
  "/chat/workspaces/$workspaceId/new": "private-no-store",
  "/workspaces/$workspaceId/$viewId/document": "private-no-store",
  "/workspaces/$workspaceId/correspondence/$correspondenceId":
    "private-no-store",
  "/workspaces/$workspaceId/invoices/$invoiceId": "private-no-store",
  "/workspaces/$workspaceId/reports/$exportId": "private-no-store",
  "/knowledge/templates/catalogue/$packId/$templateId": "public-indexable",
  "/law/$country/cases/$court/$slug": "public-indexable",
  "/sitemaps/law-cases/$country/$year/{$month}.xml": "public-anonymous",
  "/workspaces/$workspaceId/$viewId/": "private-no-store",
  "/law/$country/statutes/$slug/": "public-indexable",
  "/law/$country/cases/$court/$language/$slug": "public-indexable",
  "/law/$country/statutes/$slug/v/$version": "public-indexable",
  "/sitemaps/law-cases/$country/$year/$month/{$bucket}.xml": "public-anonymous",
} as const satisfies Record<FileRouteTypes["fullPaths"], CacheClass>;

const isDeclaredRoute = (
  path: string,
): path is keyof typeof ROUTE_CACHE_CLASSES =>
  Object.hasOwn(ROUTE_CACHE_CLASSES, path);

const routeCacheClass = (path: string): CacheClass => {
  if (!isDeclaredRoute(path)) {
    return panic("Route response policy is missing.");
  }
  return ROUTE_CACHE_CLASSES[path];
};

export const ssrCacheClassHeaders = (cacheClass: CacheClass) => ({
  [SSR_CACHE_CLASS_HEADER]: cacheClass,
});

type DocumentResponsePolicyOptions = {
  match:
    | {
        fullPath: string;
        pathname: string;
        status: string;
        ssr?: boolean | "data-only";
      }
    | undefined;
  crawl: PublicCrawlOptions;
};

export const documentResponsePolicyHeaders = ({
  match,
  crawl,
}: DocumentResponsePolicyOptions) => {
  if (!match || match.ssr === false || match.status !== "success") {
    return ssrCacheClassHeaders("private-no-store");
  }
  const cacheClass = routeCacheClass(match.fullPath);
  if (
    cacheClass !== "public-indexable" ||
    !isPublicCrawlPath(match.pathname.replace(/\/$/u, ""), crawl)
  ) {
    return ssrCacheClassHeaders("private-no-store");
  }
  return ssrCacheClassHeaders(cacheClass);
};
