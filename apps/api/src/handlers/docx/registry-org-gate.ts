/**
 * Org-enabled gating for the registry-lookup fill path.
 *
 * A template can declare a lookup against any business registry, but at fill
 * (or preview) time the resolver must refuse a registry the organization has
 * disabled via its native-tool settings — exactly as the contacts lookup route
 * (`contacts/business-registries-lookup.ts`) does per request. This builds the
 * predicate `createDispatchLookupResolver` consumes, from a single org-settings
 * read at the handler boundary, so the resolver stays injectable and the org
 * read is not buried inside the per-value resolution loop.
 */

import type { ScopedDb } from "@/api/db/safe-db";
import type { LookupRegistry } from "@/api/handlers/docx/types";
import { isNativeToolEnabledForOrg } from "@/api/handlers/mcp-connectors/catalog-metadata";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";

/** Synchronous registry-enabled predicate the boundary builds once per request
 *  (the org read is done up front), assignable to the resolver's broader
 *  {@link import("./lookup-fields").IsRegistryEnabledForOrg}. */
type SyncIsRegistryEnabledForOrg = (registry: LookupRegistry) => boolean;

/**
 * Load the org's native-tool settings once, then return a synchronous
 * predicate that gates a lookup registry on whether its `nativeToolSlug` is
 * enabled for the org. Mirrors the contacts lookup route: the same
 * `isNativeToolEnabledForOrg` check, keyed by the registry handler's
 * `nativeToolSlug`, with the same default-on jurisdiction logic and explicit
 * per-slug overrides.
 */
export const buildIsRegistryEnabledForOrg = async ({
  organizationId,
  scopedDb,
}: {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): Promise<SyncIsRegistryEnabledForOrg> => {
  const settings = await scopedDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: organizationId } },
      columns: {
        practiceJurisdictions: true,
        nativeToolOverrides: true,
      },
    }),
  );
  const practiceJurisdictions = arrayOrEmpty(settings?.practiceJurisdictions);
  const nativeToolOverrides = settings?.nativeToolOverrides ?? {};

  return (registry: LookupRegistry): boolean =>
    isNativeToolEnabledForOrg({
      slug: BUSINESS_REGISTRY_DISPATCH[registry].nativeToolSlug,
      practiceJurisdictions,
      nativeToolOverrides,
    });
};
