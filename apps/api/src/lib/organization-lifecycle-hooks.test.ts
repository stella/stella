import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerAnalytics } from "@/api/lib/analytics/server-analytics";
import { toSafeId } from "@/api/lib/branded-types";
import { createOrganizationLifecycleHooks } from "@/api/lib/organization-lifecycle-hooks";

const identifyOrganizationGroup =
  mock<ServerAnalytics["identifyOrganizationGroup"]>();
const seedDefaultDocumentTypes = mock(async () => await Promise.resolve());
const seedMemberDefaults = mock<
  Parameters<typeof createOrganizationLifecycleHooks>[0]["seedMemberDefaults"]
>(async () => await Promise.resolve());
const analytics: ServerAnalytics = {
  capture: () => undefined,
  identifyOrganizationGroup,
  flush: async () => await Promise.resolve(),
};

const orgId = toSafeId<"organization">("3f6e0a7e-9f6f-4a53-9a3e-2b8f6f0c9d41");
const userId = toSafeId<"user">("member-user-1");

const hooks = createOrganizationLifecycleHooks({
  analytics,
  seedDefaultDocumentTypes,
  seedMemberDefaults,
});

describe("organization lifecycle hooks", () => {
  beforeEach(() => {
    identifyOrganizationGroup.mockClear();
    seedDefaultDocumentTypes.mockClear();
    seedMemberDefaults.mockClear();
  });

  test("each new membership seeds that member's defaults once", async () => {
    const member = { organizationId: orgId, userId };

    await hooks.afterAddMember({ member });
    await hooks.afterAcceptInvitation({ member });
    await hooks.afterCreateOrganization({
      organization: { id: orgId, name: "Acme Legal" },
    });

    expect(seedMemberDefaults.mock.calls).toEqual([[member], [member]]);
  });

  test("afterCreateOrganization seeds document types, then names the group", async () => {
    await hooks.afterCreateOrganization({
      organization: { id: orgId, name: "Acme Legal" },
    });

    expect(seedDefaultDocumentTypes).toHaveBeenCalledWith(orgId);
    expect(identifyOrganizationGroup).toHaveBeenCalledTimes(1);
    expect(identifyOrganizationGroup).toHaveBeenCalledWith({
      organizationId: orgId,
      properties: { name: "Acme Legal" },
    });
  });

  test("afterUpdateOrganization re-sends the current name", async () => {
    await hooks.afterUpdateOrganization({
      organization: { id: orgId, name: "Acme Legal LLP" },
    });

    expect(seedDefaultDocumentTypes).not.toHaveBeenCalled();
    expect(identifyOrganizationGroup).toHaveBeenCalledTimes(1);
    expect(identifyOrganizationGroup).toHaveBeenCalledWith({
      organizationId: orgId,
      properties: { name: "Acme Legal LLP" },
    });
  });

  test("afterUpdateOrganization skips a missing updated row", async () => {
    await hooks.afterUpdateOrganization({ organization: null });

    expect(identifyOrganizationGroup).not.toHaveBeenCalled();
  });
});
