import { panic, Result } from "better-result";
import { and, count, eq } from "drizzle-orm";
import * as v from "valibot";

import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";
import {
  BROWSER_SITE_GRANT_REFUSAL_CODE,
  BROWSER_SITE_GRANTS_MAX,
  browserSiteGrantOrigin,
} from "@stll/api-contract/browser-site-grants";

import { chatBrowserSiteGrants } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockChatOwnerStoredContentTransitionOnTx } from "@/api/lib/chat/thread-stored-content-egress";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { holdMemberAccessOnTx } from "@/api/lib/db/member-access-hold";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { authorizeOrganizationReplay } from "@/api/lib/idempotency/organization-replay-authorization";

const config = {
  contract: "patch",
  idempotency: { type: "replay" },
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  body: v.object({
    /** A page on the site; the API keeps only its origin. */
    url: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
    ),
  }),
} satisfies HandlerConfig;

/**
 * Store a standing approval for chat's browser actions on one website. The
 * API keys it on the URL's exact HTTPS origin and refuses anything else.
 * Storing it again is a no-op (unique per user, organization and origin).
 */
const createBrowserSiteGrant = createSafeRootHandler(
  config,
  async function* ({ body: { url }, recordAuditEvent, safeDb, session, user }) {
    const origin = browserSiteGrantOrigin(url);
    if (origin === null) {
      return Result.err(
        new HandlerError({
          code: BROWSER_SITE_GRANT_REFUSAL_CODE.notHttps,
          status: 422,
          message: "Only an HTTPS website can be allowed",
        }),
      );
    }
    const organizationId = session.activeOrganizationId;

    const stored = yield* Result.await(
      safeDb(async (tx) => {
        // Member removal takes this fence before it deletes the member's
        // approvals, so a grant either lands before the removal deletes it,
        // or waits and then finds the member gone.
        await lockChatOwnerStoredContentTransitionOnTx(tx, {
          organizationId,
          userId: user.id,
        });
        const membership = await holdMemberAccessOnTx(tx, {
          organizationId,
          userId: user.id,
          workspaceIds: [],
        });
        if (membership.type === "not-member") {
          return Result.err(
            new HandlerError({
              code: "forbidden",
              status: 403,
              message: "Only a member of the organization can allow a website",
            }),
          );
        }
        // The same per-user collection lock as tool grants: one writer at a
        // time keeps the cap exact.
        await withAggregateLock({
          tx,
          aggregate: "chatToolGrants",
          id: { organizationId, userId: user.id },
        });
        const owned = and(
          eq(chatBrowserSiteGrants.organizationId, organizationId),
          eq(chatBrowserSiteGrants.userId, user.id),
        );
        const existing = (
          await tx
            .select({ id: chatBrowserSiteGrants.id })
            .from(chatBrowserSiteGrants)
            .where(and(owned, eq(chatBrowserSiteGrants.origin, origin)))
            .limit(1)
        ).at(0);
        if (existing) {
          return Result.ok({ created: false, id: existing.id, origin });
        }
        const held =
          (
            await tx
              .select({ held: count() })
              .from(chatBrowserSiteGrants)
              .where(owned)
          ).at(0)?.held ?? 0;
        if (held >= BROWSER_SITE_GRANTS_MAX) {
          return Result.err(
            new HandlerError({
              code: BROWSER_SITE_GRANT_REFUSAL_CODE.limitReached,
              status: 409,
              message: `At most ${BROWSER_SITE_GRANTS_MAX} websites can be allowed; remove one in settings first`,
            }),
          );
        }
        const inserted =
          (
            await tx
              .insert(chatBrowserSiteGrants)
              .values({ organizationId, userId: user.id, origin })
              .returning({ id: chatBrowserSiteGrants.id })
          ).at(0) ?? panic("A website approval insert returned no row");
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_BROWSER_SITE_GRANT,
          resourceId: inserted.id,
          workspaceId: null,
          metadata: { browserOrigin: origin, scope: "always" },
        });
        return Result.ok({ created: true, id: inserted.id, origin });
      }),
    );

    return stored;
  },
  { authorize: authorizeOrganizationReplay },
);

declareAggregateMutation(createBrowserSiteGrant, {
  type: "aggregate",
  aggregates: ["chatOwnerStoredContentEgress", "chatToolGrants"],
});

export default createBrowserSiteGrant;
