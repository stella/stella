import { panic, Result } from "better-result";

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
import type { UserDispatchSource } from "@/api/lib/db/audit-recording";
import { isMemberRole } from "@/api/lib/member-roles";
import { isSyntheticPrincipal } from "@/api/lib/synthetic-principal/constants";

/** Chat work the server starts for a member, with no request of theirs. */
export type ServerStartedChatWork =
  /** Sending the thread's next message the member queued. */
  | {
      type: "queued-send";
      threadId: SafeId<"chatThread">;
      queuedMessageId: SafeId<"chatMessage">;
    }
  /** Continuing the member's turn after the task running it stopped. */
  | {
      type: "turn-handover";
      threadId: SafeId<"chatThread">;
      turnId: SafeId<"chatTurn">;
    };

/** The work the server is about to do, and whose it is. */
export type ServerStartedMemberRequest = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  work: ServerStartedChatWork;
  /** Ends the work when the process stops. */
  signal: AbortSignal;
};

type ServerStartedMember =
  | {
      type: "member";
      caller: SessionMemberCaller;
      request: Request;
    }
  /** The member may no longer act here; nothing is done. */
  | { type: "unavailable" };

/** How the work reads in the member's session id, request and audit trail. */
const workOrigin = (
  work: ServerStartedChatWork,
): {
  sessionId: string;
  path: string;
  source: UserDispatchSource;
  sourceId: string;
} => {
  switch (work.type) {
    case "queued-send":
      return {
        sessionId: `chat-queue:${work.queuedMessageId}`,
        path: `/chat/threads/${work.threadId}/queue/send`,
        source: "chat_queue",
        sourceId: work.queuedMessageId,
      };
    case "turn-handover":
      return {
        sessionId: `chat-turn-handover:${work.turnId}`,
        path: `/chat/threads/${work.threadId}/turns/${work.turnId}/handover`,
        source: "chat_turn_handover",
        sourceId: work.turnId,
      };
    default:
      work satisfies never;
      return panic("Unknown server-started chat work");
  }
};

/**
 * The member the server does chat work as. The server starts this work with
 * no request and holds no credential of the member's: every fact a request
 * would prove is read again now, from a fresh membership lookup, and the
 * member context is built from it through the same `resolveValidateAuth`
 * every request uses (role and feature access, organization settings and AI
 * configuration, the member's own scoped connections, matter access). The
 * checks the work runs on that context then hold as for any request. A
 * member removed from the organization, a role without chat, a review or
 * demo account outside its bounds, a deleted account, or the monitoring
 * principal is refused here.
 *
 * This module is the only place besides the request resolvers in
 * `lib/auth.ts` that builds a `ResolvedIdentity` or calls
 * `resolveValidateAuth` (ownership row `server-started-member`). Every audit
 * event of the work names the member as performer and says what the server
 * started it from (the queued message, or the turn it continued).
 */
export const resolveServerStartedMember = async ({
  organizationId,
  signal,
  userId,
  work,
}: ServerStartedMemberRequest) =>
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
      return { type: "unavailable" } satisfies ServerStartedMember;
    }
    const { memberId } = authorization;
    const origin = workOrigin(work);
    const identity: ResolvedIdentity = {
      userId,
      email: authorization.email,
      // No session exists; handlers that log a session id see the origin.
      sessionId: origin.sessionId,
      originConsentId: null,
      // The work's stream has no viewer; should one join, it holds while
      // the membership this work was proved under still does.
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
      new URL(origin.path, env.BETTER_AUTH_URL).href,
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
          source: origin.source,
          sourceId: origin.sourceId,
        },
      },
    });
    if (!built.ok) {
      return { type: "unavailable" } satisfies ServerStartedMember;
    }
    return {
      type: "member",
      request,
      caller: built.value,
    } satisfies ServerStartedMember;
  });
