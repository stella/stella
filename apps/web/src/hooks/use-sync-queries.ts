import { useEffect } from "react";

import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { getSyncActorConfig } from "@stella/rivet/actors/sync-actor-config";
import type { SyncActorEvent } from "@stella/rivet/actors/sync-actor-config";

import { useAnalytics } from "@/lib/analytics/provider";
import { useActor } from "@/lib/api";
import { sessionOptions } from "@/routes/-queries";

const invalidateEvent: SyncActorEvent["name"] = "invalidate-query";

export const useSyncQueries = () => {
  const analytics = useAnalytics();
  const { data } = useSuspenseQuery(sessionOptions);

  const organizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const queryClient = useQueryClient();

  const actor = useActor(
    getSyncActorConfig({
      type: "react",
      isDev: import.meta.env.DEV,
      organizationId,
      authToken: data?.session.token,
    }),
  );

  useEffect(() => {
    if (actor.error) {
      analytics.captureError(actor.error);
    }
  }, [actor.error, analytics]);

  actor.useEvent(invalidateEvent, (queryKey: SyncActorEvent["data"]) => {
    // eslint-disable-next-line typescript/no-floating-promises
    queryClient.invalidateQueries({ queryKey });
  });
};
