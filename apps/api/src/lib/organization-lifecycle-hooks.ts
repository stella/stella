import type { ServerAnalytics } from "@/api/lib/analytics/server-analytics";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";

// The subset of the plugin's organization row the hooks read. Declared
// narrower than better-auth's hook payload so tests can call the hooks with a
// minimal fixture; parameter contravariance keeps the hooks assignable to the
// plugin's `organizationHooks`.
type PersistedOrganization = {
  id: string;
  name: string;
};

// The subset of the plugin's member row the membership hooks read.
type PersistedMember = {
  organizationId: string;
  userId: string;
};

export type NewMembership = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type OrganizationLifecycleHooksOptions = {
  analytics: ServerAnalytics;
  seedDefaultDocumentTypes: (
    organizationId: SafeId<"organization">,
  ) => Promise<void>;
  seedMemberDefaults: (membership: NewMembership) => Promise<void>;
};

// Mirrors the organization's display name onto its PostHog group profile so
// insights and group pages show a name instead of an opaque id.
const identifyOrganizationName = (
  analytics: ServerAnalytics,
  { id, name }: PersistedOrganization,
): void => {
  analytics.identifyOrganizationGroup({
    organizationId: brandPersistedOrganizationId(id),
    properties: { name },
  });
};

// Organization and membership hooks for the better-auth organization plugin,
// built as a factory so the seeding steps and analytics sink can be
// substituted in tests. Ids are read off the rows the plugin persisted, so
// they become ownership ids here.
export const createOrganizationLifecycleHooks = ({
  analytics,
  seedDefaultDocumentTypes,
  seedMemberDefaults,
}: OrganizationLifecycleHooksOptions) => {
  // The plugin creates a membership through `createOrganization` (for the
  // creator) and `addMember`, which fire afterAddMember, or through
  // `acceptInvitation`, which fires afterAcceptInvitation.
  const seedNewMember = async ({
    member,
  }: {
    member: PersistedMember;
  }): Promise<void> => {
    await seedMemberDefaults({
      organizationId: brandPersistedOrganizationId(member.organizationId),
      userId: brandPersistedUserId(member.userId),
    });
  };

  return {
    afterAddMember: seedNewMember,
    afterAcceptInvitation: seedNewMember,
    afterCreateOrganization: async ({
      organization: org,
    }: {
      organization: PersistedOrganization;
    }): Promise<void> => {
      // Seed the org's starter document-type taxonomy at creation so listing
      // it stays a pure read: a read-only credential must not be able to mint
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
  };
};
