import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";

import { getChatActorConfig } from "@stella/rivet/actors/chat-actor-config";

import { createActorProvider } from "@/hooks/create-actor-provider";
import { sessionOptions } from "@/routes/-queries";

const { ActorProvider, useSuspenseActor: useSuspenseChatActor } =
  createActorProvider<"chat">();

export { useSuspenseChatActor };

/**
 * Keeps the chat actor mounted (and its WebSocket alive)
 * regardless of whether children are suspended.
 *
 * Must be rendered ABOVE any `<Suspense>` boundary that
 * wraps components calling `useSuspenseChatActor`.
 */
export const ChatActorProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const { data } = useSuspenseQuery(sessionOptions);
  const user = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user,
  });

  const config = getChatActorConfig({
    type: "react",
    organizationId: user.activeOrganizationId,
    userId: user.id,
    authToken: data?.session.token,
  });

  return <ActorProvider config={config}>{children}</ActorProvider>;
};
