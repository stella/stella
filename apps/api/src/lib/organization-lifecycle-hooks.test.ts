import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerAnalytics } from "@/api/lib/analytics/server-analytics";
import { toSafeId } from "@/api/lib/branded-types";
import { createOrganizationLifecycleHooks } from "@/api/lib/organization-lifecycle-hooks";

const identifyOrganizationGroup =
  mock<ServerAnalytics["identifyOrganizationGroup"]>();
const calls: string[] = [];
const recordAccessState = mock(async () => {
  calls.push("recordAccessState");
  await Promise.resolve();
});
const recordProfessionalUse = mock<
  Parameters<
    typeof createOrganizationLifecycleHooks
  >[0]["recordProfessionalUse"]
>(async () => {
  calls.push("recordProfessionalUse");
  await Promise.resolve();
});
const seedDefaultDocumentTypes = mock(async () => {
  calls.push("seedDefaultDocumentTypes");
  await Promise.resolve();
});
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
  recordAccessState,
  recordProfessionalUse,
  seedDefaultDocumentTypes,
  seedMemberDefaults,
});

describe("organization lifecycle hooks", () => {
  beforeEach(() => {
    calls.length = 0;
    identifyOrganizationGroup.mockClear();
    recordAccessState.mockClear();
    recordProfessionalUse.mockClear();
    seedDefaultDocumentTypes.mockClear();
    seedMemberDefaults.mockClear();
  });

  test("each new membership seeds that member's defaults once", async () => {
    const member = { organizationId: orgId, userId };

    await hooks.afterAddMember({ member });
    await hooks.afterAcceptInvitation({ member });
    await hooks.afterCreateOrganization({
      organization: { id: orgId, name: "Acme Legal" },
      user: { id: userId },
    });

    expect(seedMemberDefaults.mock.calls).toEqual([[member], [member]]);
  });

  test("afterCreateOrganization records the access state and the creator's professional-use acceptance, seeds document types, then names the group", async () => {
    await hooks.afterCreateOrganization({
      organization: { id: orgId, name: "Acme Legal" },
      user: { id: userId },
    });

    expect(recordAccessState).toHaveBeenCalledWith(orgId);
    expect(recordProfessionalUse).toHaveBeenCalledWith({
      organizationId: orgId,
      userId,
    });
    expect(seedDefaultDocumentTypes).toHaveBeenCalledWith(orgId);
    expect(calls).toEqual([
      "recordAccessState",
      "recordProfessionalUse",
      "seedDefaultDocumentTypes",
    ]);
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

    expect(recordAccessState).not.toHaveBeenCalled();
    expect(recordProfessionalUse).not.toHaveBeenCalled();
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
