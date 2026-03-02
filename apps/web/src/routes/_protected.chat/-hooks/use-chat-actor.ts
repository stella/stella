import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { getChatActorConfig } from "@stella/rivet/actors/chat-actor-config";

import { useActor } from "@/lib/api";
import { sessionOptions } from "@/routes/-queries";

export const useChatActor = () => {
  const { data } = useSuspenseQuery(sessionOptions);
  const user = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user,
  });

  return useActor(
    getChatActorConfig({
      type: "react",
      organizationId: user.activeOrganizationId,
      userId: user.id,
      authToken: data?.session.token,
    }),
  );
};
