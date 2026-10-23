import type { GenericEndpointContext } from "@better-auth/core";
import { runWithAdapter } from "@better-auth/core/context";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { setSessionCookie } from "better-auth/cookies";
import { Result, TaggedError } from "better-result";

import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import type { createWebHandoffService } from "@/api/lib/auth/mcp-web-handoff";
import { webHandoffFailure } from "@/api/lib/auth/mcp-web-handoff";
import { requireAuthRetention } from "@/api/lib/auth/registration-adapter";

class HandoffCompletionError extends TaggedError("HandoffCompletionError")<{
  message: string;
}> {}

type WebHandoffService = ReturnType<typeof createWebHandoffService>;
type HandoffSessionCompletionOptions = {
  ctx: GenericEndpointContext;
  completionContext: Parameters<
    Parameters<WebHandoffService["consume"]>[0]["complete"]
  >[0];
  existing: GenericEndpointContext["context"]["session"];
  originalSession: GenericEndpointContext["context"]["newSession"];
  now: () => Date;
  textSessionMaxSeconds: () => number;
};

export const completeHandoffSession = async ({
  ctx,
  completionContext,
  existing,
  originalSession,
  now,
  textSessionMaxSeconds,
}: HandoffSessionCompletionOptions) => {
  // The internal adapter keeps its hooks while every session write uses this transaction.
  requireAuthRetention({ model: "session" });
  const adapter = drizzleAdapter(completionContext.transaction, {
    ...AUTH_DATABASE_ADAPTER_OPTIONS,
    transaction: false,
  })(ctx.context.options);
  const completion = await Result.tryPromise({
    try: async () =>
      await runWithAdapter(adapter, async () => {
        if (
          existing?.user.id === completionContext.userId &&
          existing.session["originConsentId"] === null
        ) {
          const updated = await ctx.context.internalAdapter.updateSession(
            existing.session.token,
            { activeOrganizationId: completionContext.organizationId },
          );
          if (!updated) {
            return Result.err(
              new HandoffCompletionError({
                message: "Session could not be updated.",
              }),
            );
          }
          await setSessionCookie(ctx, {
            session: updated,
            user: existing.user,
          });
          // Refreshing an existing cookie is not a new-device sign-in.
          ctx.context.setNewSession(originalSession);
          return Result.ok(updated.id);
        }
        const account = await ctx.context.internalAdapter.findUserById(
          completionContext.userId,
        );
        if (!account) {
          return Result.err(
            new HandoffCompletionError({ message: "Account is unavailable." }),
          );
        }
        const absoluteDeadline =
          completionContext.handoff.kind === "text"
            ? new Date(now().getTime() + textSessionMaxSeconds() * 1000)
            : null;
        const created = await ctx.context.internalAdapter.createSession(
          completionContext.userId,
          false,
          {
            activeOrganizationId: completionContext.organizationId,
            originConsentId: completionContext.consentId,
            handoffAbsoluteExpiresAt: absoluteDeadline,
            lastSeenAt: now(),
            ...(absoluteDeadline ? { expiresAt: absoluteDeadline } : {}),
          },
          // Better Auth otherwise replaces expiresAt with its default lifetime.
          true,
        );
        // Replacing a handoff session transfers ownership and lifetime to this consent.
        if (existing && existing.session["originConsentId"] !== null) {
          await ctx.context.internalAdapter.deleteSession(
            existing.session.token,
          );
        }
        await setSessionCookie(ctx, { session: created, user: account });
        return Result.ok(created.id);
      }),
    catch: webHandoffFailure(
      "complete_session",
      "Web handoff session could not be completed.",
    ),
  });
  return Result.isOk(completion) ? completion.value : completion;
};
