import { Result } from "better-result";

import { env } from "@/api/env";
import {
  resolveCredentialMemberAuthorization,
  type ResolvedIdentity,
  resolveValidateAuth,
  type SessionMemberCaller,
} from "@/api/lib/auth";
import { checkDemoAccountOperation } from "@/api/lib/auth/demo-account";
import { checkReviewAccountOrganization } from "@/api/lib/auth/review-account";
import type { SafeId } from "@/api/lib/branded-types";
import { isMemberRole } from "@/api/lib/member-roles";
import { isSyntheticPrincipal } from "@/api/lib/synthetic-principal/constants";

/** The queued message the server is about to send, and who queued it. */
export type QueuedTurnRequest = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  threadId: SafeId<"chatThread">;
  queuedMessageId: SafeId<"chatMessage">;
  /** Ends the send when the process stops. */
  signal: AbortSignal;
};

type QueuedTurnMember =
  | {
      type: "member";
      caller: SessionMemberCaller;
      request: Request;
    }
  /** The member may no longer act here; nothing is sent. */
  | { type: "unavailable" };

/**
 * The member a queued message is sent as. The server starts this turn with
 * no request and holds no credential of the member's: every fact a request
 * would prove is read again now, from a fresh membership lookup, and the
 * member context is built from it through the same `resolveValidateAuth`
 * every request uses (role and feature access, organization settings and AI
 * configuration, the member's own scoped connections, matter access). The
 * route checks of the send (permissions, account access, feature access,
 * usage) then run on that context as for any request. A member removed from
 * the organization, a role without chat, a review or demo account outside
 * its bounds, a deleted account, or the monitoring principal is refused
 * here.
 *
 * This module is the only place besides the request resolvers in
 * `lib/auth.ts` that builds a `ResolvedIdentity` or calls
 * `resolveValidateAuth` (ownership row `queued-turn-member`). Every audit
 * event of the turn names the member as performer and says it started from
 * the queue, with the queued message as its source.
 */
export const resolveQueuedTurnMember = async ({
  organizationId,
  queuedMessageId,
  signal,
  threadId,
  userId,
}: QueuedTurnRequest) =>
  await Result.tryPromise(async () => {
    const authorization = await resolveCredentialMemberAuthorization({
      organizationId,
      userId,
      workspaceId: undefined,
    });
    if (
      authorization === null ||
      authorization.userDeleted ||
      !isMemberRole(authorization.role) ||
      isSyntheticPrincipal({
        email: authorization.email,
        organizationId,
        userId,
      }) ||
      Result.isError(
        checkDemoAccountOperation(authorization.email).andThen(() =>
          checkReviewAccountOrganization({
            email: authorization.email,
            organizationId,
          }),
        ),
      )
    ) {
      return { type: "unavailable" } satisfies QueuedTurnMember;
    }
    const { memberId } = authorization;
    const identity: ResolvedIdentity = {
      userId,
      email: authorization.email,
      // No session exists; handlers that log a session id see the queue.
      sessionId: `chat-queue:${queuedMessageId}`,
      originConsentId: null,
      // The turn's stream has no viewer; should one join, it holds while
      // the membership this send was proved under still does.
      stream: {
        kind: "credential",
        revalidate: async () =>
          (
            await resolveCredentialMemberAuthorization({
              organizationId,
              userId,
              workspaceId: undefined,
            })
          )?.memberId === memberId,
      },
      organizationId,
      authorization: { ...authorization, role: authorization.role },
    };
    const request = new Request(
      new URL(`/chat/threads/${threadId}/queue/send`, env.BETTER_AUTH_URL).href,
      { method: "POST", signal },
    );
    const built = await resolveValidateAuth({
      identity,
      initialWorkspaceId: null,
      request,
      server: null,
      execution: {
        performer: { type: "user", id: userId },
        trigger: {
          type: "user_dispatch",
          userId,
          source: "chat_queue",
          sourceId: queuedMessageId,
        },
      },
    });
    if (!built.ok) {
      return { type: "unavailable" } satisfies QueuedTurnMember;
    }
    return {
      type: "member",
      request,
      caller: built.value,
    } satisfies QueuedTurnMember;
  });
