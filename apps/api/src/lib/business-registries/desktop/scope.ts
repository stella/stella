import { and, eq, sql } from "drizzle-orm";

import { apikey } from "@/api/db/auth-schema";
import type { SafeId } from "@/api/lib/branded-types";
import { DESKTOP_REGISTRY_KEY_CONFIG } from "@/api/lib/business-registries/desktop/config";

/**
 * The one definition of "this organization's desktop registry keys", shared by
 * the desktop's own sign-out (`revocation.ts`) and the membership lifecycle
 * (`lib/auth-artifacts.ts`). `apikey` denies the scoped Stella role, so this
 * `WHERE` clause is the tenant boundary for both.
 */
export const desktopRegistryKeyOrganizationScope = (
  organizationId: SafeId<"organization">,
) =>
  and(
    eq(apikey.configId, DESKTOP_REGISTRY_KEY_CONFIG),
    sql`${apikey.metadata}::text::jsonb ->> 'organizationId' = ${organizationId}`,
    sql`${apikey.metadata}::text::jsonb ->> 'purpose' = ${DESKTOP_REGISTRY_KEY_CONFIG}`,
  );
