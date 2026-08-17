import type { Analytics } from "@/api/lib/analytics/types";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

// The subset of the plugin's organization row the hooks read. Declared
// narrower than better-auth's hook payload so tests can call the hooks with a
// minimal fixture; parameter contravariance keeps the hooks assignable to the
// plugin's `organizationHooks`.
type PersistedOrganization = {
  id: string;
  name: string;
};

type OrganizationLifecycleHooksOptions = {
  analytics: Analytics;
  seedDefaultDocumentTypes: (
    organizationId: SafeId<"organization">,
  ) => Promise<void>;
};

// Mirrors the organization's display name onto its PostHog group profile so
// insights and group pages show a name instead of an opaque id.
const identifyOrganizationName = (
  analytics: Analytics,
  { id, name }: PersistedOrganization,
): void => {
  analytics.identifyOrganizationGroup({
    organizationId: brandPersistedOrganizationId(id),
    properties: { name },
  });
};

// Organization create/update hooks for the better-auth organization plugin,
// built as a factory so the seeding step and analytics sink can be
// substituted in tests. `org.id` is read off the row the plugin persisted, so
// it becomes the ownership id here.
export const createOrganizationLifecycleHooks = ({
  analytics,
  seedDefaultDocumentTypes,
}: OrganizationLifecycleHooksOptions) => ({
  afterCreateOrganization: async ({
    organization: org,
  }: {
    organization: PersistedOrganization;
  }): Promise<void> => {
    // Seed the org's starter document-type taxonomy at creation so listing it
    // stays a pure read: a read-only credential must not be able to mint
    // document types by listing them.
    await seedDefaultDocumentTypes(brandPersistedOrganizationId(org.id));
    identifyOrganizationName(analytics, org);
  },
  afterUpdateOrganization: async ({
    organization: org,
  }: {
    organization: PersistedOrganization | null;
  }): Promise<void> => {
    // The plugin passes `null` when the adapter returns no updated row.
    if (!org) {
      return;
    }
    // Fires for every organization update, not just renames; the group
    // upsert is idempotent so re-sending an unchanged name is harmless.
    identifyOrganizationName(analytics, org);
    await Promise.resolve();
  },
});
