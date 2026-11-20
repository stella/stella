import { organizationSettingsQueryRoot } from "@/lib/resource-query-roots.logic";

/*
 * The organization settings read's cache keys, apart from the read itself
 * (`./organization-settings.ts`), so a module that only looks into the cache
 * (a loading view reading the cached features) does not load the API client.
 */

/** The member a settings read is for, in the organization they act in. */
export type OrganizationSettingsCaller = {
  organizationId: string;
  userId: string;
};

/** A caller whose organization may not be known yet. */
export type OptionalOrganizationSettingsCaller = Omit<
  OrganizationSettingsCaller,
  "organizationId"
> & {
  organizationId: string | null;
};

export const organizationSettingsKeys = {
  all: organizationSettingsQueryRoot(),
  byOrganization: (organizationId: string | null) => [
    ...organizationSettingsKeys.all,
    organizationId,
  ],
  byCaller: ({
    organizationId,
    userId,
  }: OptionalOrganizationSettingsCaller) => [
    ...organizationSettingsKeys.byOrganization(organizationId),
    userId,
  ],
};
