import { panic } from "better-result";

import { isPublicCrawlPath } from "@/public-crawl-policy";
import type { PublicCrawlOptions } from "@/public-crawl-policy";
import type { FileRouteTypes } from "@/routeTree.gen";

export type CacheClass =
  "private-no-store" | "public-anonymous" | "public-indexable";

export const SSR_CACHE_CLASS_HEADER = "x-stella-cache-class";

export const PRIVATE_CACHE_CONTROL = "private, no-store";

/**
 * A public document rendered for a request without credentials. Browsers
 * revalidate it every time; a shared cache may serve it for a few minutes
 * and a little longer while it fetches a fresh copy.
 */
export const ANONYMOUS_DOCUMENT_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=600";

/**
 * What a shared cache may do with a response of each class:
 * - `never`: nothing; the response is private.
 * - `origin-policy`: keep the route's own Cache-Control (a sitemap or a file
 *   that is the same for every viewer and is never HTML).
 * - `anonymous-document`: an HTML document that is the same for every viewer
 *   without credentials, so only such a request's response may be cached.
 */
type SharedCachePolicy = "never" | "origin-policy" | "anonymous-document";

export const CACHE_CLASS_POLICIES = {
  "private-no-store": { indexable: false, sharedCache: "never" },
  "public-anonymous": { indexable: false, sharedCache: "origin-policy" },
  "public-indexable": { indexable: true, sharedCache: "anonymous-document" },
} as const satisfies Record<
  CacheClass,
  { indexable: boolean; sharedCache: SharedCachePolicy }
>;

const isCacheClass = (value: string | null): value is CacheClass =>
  value !== null && Object.hasOwn(CACHE_CLASS_POLICIES, value);

type ResponseCachePolicyInput = {
  /** The class the route declared, or null when it declared none. */
  cacheClass: string | null;
  status: number;
  isHtml: boolean;
  /** The request carried no cookie and no authorization. */
  isAnonymous: boolean;
  /** The response sets a cookie. */
  setsCookie: boolean;
  /** The Cache-Control the route sent, if any. */
  routeCacheControl: string | null;
};

type ResponseCachePolicy = {
  cacheControl: string;
  /** A shared cache may store the response. */
  shared: boolean;
  /** Headers a shared cache must key on, when it may store the response. */
  vary: string | null;
  indexable: boolean;
};

const PRIVATE_POLICY = {
  cacheControl: PRIVATE_CACHE_CONTROL,
  shared: false,
  vary: null,
} as const;

/**
 * The final Cache-Control, Vary and indexability of a server response. Only a
 * successful response may be shared, and never one that sets a cookie; an
 * error, a redirect or a not-found is always private.
 */
export const responseCachePolicy = ({
  cacheClass,
  status,
  isHtml,
  isAnonymous,
  setsCookie,
  routeCacheControl,
}: ResponseCachePolicyInput): ResponseCachePolicy => {
  const isSuccessful = status >= 200 && status < 300;
  if (!isCacheClass(cacheClass) || !isSuccessful) {
    return { ...PRIVATE_POLICY, indexable: false };
  }
  const policy = CACHE_CLASS_POLICIES[cacheClass];
  const indexable = policy.indexable && isHtml;
  if (setsCookie) {
    return { ...PRIVATE_POLICY, indexable };
  }
  switch (policy.sharedCache) {
    case "never":
      return { ...PRIVATE_POLICY, indexable };
    case "origin-policy":
      return isHtml || routeCacheControl === null
        ? { ...PRIVATE_POLICY, indexable }
        : {
            cacheControl: routeCacheControl,
            shared: true,
            vary: null,
            indexable,
          };
    case "anonymous-document":
      return isHtml && isAnonymous
        ? {
            cacheControl: ANONYMOUS_DOCUMENT_CACHE_CONTROL,
            shared: true,
            // The document is rendered in the request's language, and a
            // request with a cookie gets its own private document.
            vary: "Accept-Language, Cookie",
            indexable,
          }
        : { ...PRIVATE_POLICY, indexable };
    default: {
      policy satisfies never;
      return panic(`Unhandled shared cache policy: ${String(policy)}`);
    }
  }
};

export const ROUTE_CACHE_CLASSES = {
  "/": "private-no-store",
  "/auth": "private-no-store",
  "/knowledge": "private-no-store",
  "/law": "private-no-store",
  "/onboarding": "private-no-store",
  "/tools": "private-no-store",
  "/agent-claim": "private-no-store",
  "/invoice-link": "private-no-store",
  "/consent": "private-no-store",
  "/dev": "private-no-store",
  "/robots.txt": "public-anonymous",
  "/sitemap.xml": "public-anonymous",
  "/chat": "private-no-store",
  "/settings": "private-no-store",
  "/time": "private-no-store",
  "/time/approvals": "private-no-store",
  "/time/report": "private-no-store",
  "/auth/handoff": "private-no-store",
  "/auth/reauth": "private-no-store",
  "/auth/error": "private-no-store",
  "/auth/organization": "private-no-store",
  "/auth/otp": "private-no-store",
  "/auth/professional-use": "private-no-store",
  "/auth/two-factor": "private-no-store",
  "/knowledge/clauses": "private-no-store",
  "/knowledge/playbooks": "private-no-store",
  "/knowledge/styles": "private-no-store",
  "/knowledge/templates": "private-no-store",
  "/knowledge/tools": "private-no-store",
  "/knowledge/workflows": "private-no-store",
  "/law/coverage": "public-indexable",
  "/mcp/oauth-callback": "private-no-store",
  "/sharepoint/oauth-callback": "private-no-store",
  "/sitemaps/law.xml": "public-anonymous",
  "/sitemaps/tools.xml": "public-anonymous",
  "/tools/$slug": "public-indexable",
  "/tools/contribute": "public-indexable",
  "/auth/": "private-no-store",
  "/knowledge/": "private-no-store",
  "/law/": "public-indexable",
  "/tools/": "public-indexable",
  "/admin": "private-no-store",
  "/settings/organization": "private-no-store",
  "/contacts": "private-no-store",
  "/workspaces": "private-no-store",
  "/workspaces/$workspaceId": "private-no-store",
  "/chat/$threadId": "private-no-store",
  "/chat/new": "private-no-store",
  "/guidance/$guidanceId": "private-no-store",
  "/chat/history": "private-no-store",
  "/contacts/$contactId": "private-no-store",
  "/contacts/import": "private-no-store",
  "/verify/$code": "private-no-store",
  "/auth/accept-invitation/$invitationId": "private-no-store",
  "/knowledge/playbooks/catalogue": "public-indexable",
  "/knowledge/templates/catalogue": "public-indexable",
  "/knowledge/templates/catalogue/": "public-indexable",
  "/knowledge/tools/$entry": "public-indexable",
  "/knowledge/tools/catalogue": "public-indexable",
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
  "/settings/account/security": "private-no-store",
  "/admin/general": "private-no-store",
  "/settings/organization/general": "private-no-store",
  "/admin/tools": "private-no-store",
  "/settings/organization/tools": "private-no-store",
  "/admin/ai": "private-no-store",
  "/settings/organization/ai": "private-no-store",
  "/admin/billing": "private-no-store",
  "/settings/organization/billing": "private-no-store",
  "/admin/anonymization": "private-no-store",
  "/admin/dictation": "private-no-store",
  "/settings/organization/anonymization": "private-no-store",
  "/settings/organization/dictation": "private-no-store",
  "/admin/audit-logs": "private-no-store",
  "/settings/organization/audit-logs": "private-no-store",
  "/admin/catalogue": "private-no-store",
  "/settings/organization/catalogue": "private-no-store",
  "/admin/document-types": "private-no-store",
  "/settings/organization/document-types": "private-no-store",
  "/admin/matter-numbering": "private-no-store",
  "/settings/organization/matter-numbering": "private-no-store",
  "/admin/members": "private-no-store",
  "/settings/organization/members": "private-no-store",
  "/admin/number-series": "private-no-store",
  "/settings/organization/number-series": "private-no-store",
  "/admin/time-policy": "private-no-store",
  "/settings/organization/time-policy": "private-no-store",
  "/admin/usage": "private-no-store",
  "/settings/organization/usage": "private-no-store",
  "/admin/vat-rates": "private-no-store",
  "/settings/organization/vat-rates": "private-no-store",
  "/workspaces/$workspaceId/expenses": "private-no-store",
  "/workspaces/$workspaceId/invoices": "private-no-store",
  "/workspaces/$workspaceId/lists": "private-no-store",
  "/workspaces/$workspaceId/timesheets": "private-no-store",
  "/workspaces/$workspaceId/workflows": "private-no-store",
  "/knowledge/company-formats/$registry/$companyId": "private-no-store",
  "/knowledge/tools/$entry/download": "public-anonymous",
  "/knowledge/tools/skills/$skillId": "private-no-store",
  "/law/cases/research/$tableId": "private-no-store",
  "/sitemaps/law-statutes/$country/{$bucket}.xml": "public-anonymous",
  "/admin/": "private-no-store",
  "/settings/organization/": "private-no-store",
  "/workspaces/$workspaceId/": "private-no-store",
  "/law/$country/statutes/": "public-indexable",
  "/law/$country/": "public-indexable",
  "/law/$country/courts/$": "public-indexable",
  "/law/cases/research/": "private-no-store",
  "/chat/workspaces/$workspaceId/$threadId": "private-no-store",
  "/chat/workspaces/$workspaceId/new": "private-no-store",
  "/workspaces/$workspaceId/$viewId/document": "private-no-store",
  "/workspaces/$workspaceId/correspondence/$correspondenceId":
    "private-no-store",
  "/workspaces/$workspaceId/invoices/$invoiceId": "private-no-store",
  "/workspaces/$workspaceId/invoices/new": "private-no-store",
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
  if (match?.fullPath === "/auth/handoff") {
    return {
      ...ssrCacheClassHeaders("private-no-store"),
      "Referrer-Policy": "no-referrer",
    };
  }
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
