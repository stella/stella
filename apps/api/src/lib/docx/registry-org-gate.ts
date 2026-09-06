/**
 * Org-enabled gating for the registry-lookup fill path.
 *
 * A template can declare a lookup against any business registry, but at fill
 * (or preview) time the resolver must refuse a registry the organization has
 * disabled via its native-tool settings — exactly as the contacts lookup route
 * (`contacts/business-registries-lookup.ts`) does per request. This builds the
 * gate `createDispatchLookupResolver` consumes, from a single org-settings
 * read at the handler boundary, so the resolver stays injectable and the org
 * read is not buried inside the per-value resolution loop.
 */

import type { ScopedDb } from "@/api/db/safe-db";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";
import { BUSINESS_REGISTRY_DISPATCH } from "@/api/lib/business-registries/dispatch";
import type { LookupRegistry } from "@/api/lib/docx/types";
import { nativeToolDisabledReasonForOrg } from "@/api/lib/mcp-connectors/catalog-metadata";
import type { NativeToolDisabledReason } from "@/api/lib/mcp-connectors/catalog-metadata";

/** Synchronous registry gate the boundary builds once per request (the org read
 *  is done up front): why the registry is off, or null when it is on.
 *  Assignable to the resolver's broader
 *  {@link import("./lookup-fields").ResolveRegistryDisabledReason}. */
type SyncResolveRegistryDisabledReason = (
  registry: LookupRegistry,
) => NativeToolDisabledReason | null;

/**
 * Load the org's native-tool settings once, then return a synchronous gate
 * that answers why a lookup registry is off for the org, keyed by the registry
 * handler's `nativeToolSlug`. Mirrors the contacts lookup route: the same
 * default-on jurisdiction logic and explicit per-slug overrides. The reason
 * travels with the refusal so it can name the recovery that actually applies.
 */
export const buildResolveRegistryDisabledReason = async ({
  organizationId,
  scopedDb,
}: {
  organizationId: SafeId<"organization">;
  scopedDb: ScopedDb;
}): Promise<SyncResolveRegistryDisabledReason> => {
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

  return (registry: LookupRegistry): NativeToolDisabledReason | null =>
    nativeToolDisabledReasonForOrg({
      slug: BUSINESS_REGISTRY_DISPATCH[registry].nativeToolSlug,
      practiceJurisdictions,
      nativeToolOverrides,
    });
};
