import { Result } from "better-result";
import { t } from "elysia";

import { confirmServiceAuthRegistration } from "@/api/lib/agent-auth";
import { confirmIdJagDelegation } from "@/api/lib/agent-auth-idjag";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Session-authenticated confirm endpoint the web claim page calls. The
 * human approves a `user_code`; we bind the pending registration to them
 * and their active org, then mint the authorization code the agent will
 * exchange. Ownership comes from the validated session — never the body.
 */
const config = {
  body: t.Object({
    user_code: t.String({ minLength: 1, maxLength: 32 }),
  }),
  // Any authenticated org member may bind an agent to themselves; the
  // agent inherits the confirming user's least-privilege scopes, not the
  // org's. `workspace: ["read"]` is the lightest "is a member" gate.
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "auth_plumbing" },
} satisfies HandlerConfig;

const agentConfirmHandler = createSafeRootHandler(
  config,
  async function* ({ body: { user_code }, request, user, session }) {
    const cookieHeader = request.headers.get("cookie") ?? "";

    const result = await confirmServiceAuthRegistration({
      userCode: user_code.trim().toUpperCase(),
      userId: user.id,
      organizationId: session.activeOrganizationId,
      sessionCookieHeader: cookieHeader,
    });

    if (result.status === "not_found") {
      return Result.err(
        new HandlerError({
          status: 404,
          message: "No pending agent claim matches that code.",
        }),
      );
    }
    if (result.status === "expired") {
      return Result.err(
        new HandlerError({
          status: 409,
          message: "This agent claim has expired.",
        }),
      );
    }

    // If this ceremony was an ID-JAG first-link step-up, the confirm
    // establishes the durable (iss, sub) delegation so the next assertion
    // routes straight through. A no-op for plain service_auth claims.
    await confirmIdJagDelegation({
      registrationId: result.registrationId,
      userId: user.id,
      organizationId: session.activeOrganizationId,
    });

    return Result.ok({ status: "claimed" });
  },
);

export default agentConfirmHandler;
