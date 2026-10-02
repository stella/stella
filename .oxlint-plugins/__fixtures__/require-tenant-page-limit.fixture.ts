import { LIMITS as PAGE_LIMITS } from "@/api/lib/limits";
import { normalizeTenantPageLimit as normalizePage } from "@/api/lib/rate-limit/action-size-limits";
import { DEFAULT_LIST_LIMIT as LIST_PAGE_DEFAULT } from "@/api/mcp/tool-utils";

declare const query: { limit?: number; pageSize?: number; windowSize?: number };
declare const body: { limit?: number };
declare const input: { limit?: number };
declare const parsed: { output: { limit?: number } };
declare const schema: (options: {
  maximum: number;
  default: number;
}) => unknown;
declare const sqlQuery: { limit: (value: number) => unknown };

export const requestPage = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- raw request page bypasses the action budget
  const limit = query.limit ?? 50;
  return limit;
};

export const bodyPage = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- body pagination needs the same owner
  const limit = Math.min(body.limit ?? 50, 100);
  return limit;
};

export const fixedDefaultPage = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- fixed defaults must also honor the tenant cap
  const pageSize = PAGE_LIMITS.contactsPageSizeDefault;
  return pageSize;
};

export const inputPage = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- native MCP input pages also belong to the action
  const limit = input.limit ?? PAGE_LIMITS.contactsPageSizeDefault;
  return limit;
};

export const parsedPage = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- validated MCP input is still operator bounded
  const limit = parsed.output.limit ?? 25;
  return limit;
};

export const aliasedMcpDefault = (requestedLimit?: number) => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- aliased MCP defaults still resolve a tenant page
  const limit = requestedLimit ?? LIST_PAGE_DEFAULT;
  return limit;
};

export const windowPage = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- windows are resolved pages too
  const windowSize = query.windowSize ?? 25;
  return windowSize;
};

export const partialNormalization = () => {
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- normalizing only the requested branch leaves the fallback unbounded
  const limit = query.limit === undefined ? 50 : normalizePage(query.limit);
  return limit;
};

export const impostorNormalizer = () => {
  const normalizeImpostor = (value: number) => value;
  // oxlint-disable-next-line require-tenant-page-limit/require-tenant-page-limit -- a local helper is not the canonical owner
  const limit = normalizeImpostor(query.limit ?? 50);
  return limit;
};

export const normalizedPage = () => {
  // expect-clean: require-tenant-page-limit/require-tenant-page-limit
  const limit = normalizePage(
    Math.min(query.limit ?? PAGE_LIMITS.contactsPageSizeDefault, 100),
  );
  // Sentinel lookahead follows the resolved page, preserving has-more detection.
  // expect-clean: require-tenant-page-limit/require-tenant-page-limit
  const windowSize = limit + 1;
  return sqlQuery.limit(windowSize);
};

export const normalizedWindow = () => {
  // expect-clean: require-tenant-page-limit/require-tenant-page-limit
  const windowSize = normalizePage(query.windowSize ?? 25);
  return windowSize;
};

export const normalizedFixedPage = () => {
  // expect-clean: require-tenant-page-limit/require-tenant-page-limit
  const pageSize = normalizePage(PAGE_LIMITS.contactsPageSizeDefault);
  return pageSize;
};

export const mutationBatch = () => {
  // expect-clean: require-tenant-page-limit/require-tenant-page-limit
  const limit = PAGE_LIMITS.propertiesCount;
  return limit;
};

export const queryBuilder = (builder: {
  limit: (value: number) => unknown;
}) => {
  // expect-clean: require-tenant-page-limit/require-tenant-page-limit
  const limit = builder.limit(50);
  return limit;
};

// Defaults and schema maxima are validation contracts, not resolved query pages.
// expect-clean: require-tenant-page-limit/require-tenant-page-limit
const pageSize = PAGE_LIMITS.contactsPageSizeDefault;
// expect-clean: require-tenant-page-limit/require-tenant-page-limit
const _requestSchema = schema({ maximum: 100, default: pageSize });

export const __tenantPageLimitFixture = { pageSize, _requestSchema };
