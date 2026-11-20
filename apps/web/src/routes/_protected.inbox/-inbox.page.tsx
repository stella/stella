import { getRouteApi } from "@tanstack/react-router";

import { EntityViews } from "@/components/entity-views/entity-views";

import { InboxShell } from "./-inbox.pending";

const protectedRouteApi = getRouteApi("/_protected");

/** /inbox: the organization's open work, in the member's saved views. */
export function InboxPage() {
  const organizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  return (
    <InboxShell>
      <EntityViews
        key={organizationId}
        organizationId={organizationId}
        scope={{ type: "organization" }}
      />
    </InboxShell>
  );
}
