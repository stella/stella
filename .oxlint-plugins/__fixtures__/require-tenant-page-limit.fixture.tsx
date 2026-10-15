import { createSafePublicHandler as publicHandler } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";

declare const query: { limit?: number };

// Public handlers own public budgets rather than tenant action budgets.
export const publicPage = publicHandler({}, () => {
  // expect-clean: require-tenant-page-limit/require-tenant-page-limit
  const limit = query.limit ?? LIMITS.contactsPageSizeDefault;
  return limit;
});

export const __publicTenantPageLimitFixture = { publicHandler, publicPage };
