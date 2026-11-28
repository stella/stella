import { Result } from "better-result";
import * as v from "valibot";

import { BROWSER_CONTROL_LIMITS } from "@stll/api-contract/browser-control";
import { browserSiteGrantOrigin } from "@stll/api-contract/browser-site-grants";
import { BROWSER_SITE_NOTE_REFUSAL_CODE } from "@stll/api-contract/browser-site-notes";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { deleteBrowserSiteNotesForSiteOnTx } from "@/api/lib/chat/browser-site-notes/store";
import { withAggregateLock } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  contract: "patch",
  permissions: { chat: ["create"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: { type: "internal", reason: "chat_thread_ui" },
  query: v.object({
    /** The website's origin, or any page on it. */
    url: v.pipe(
      v.string(),
      v.minLength(1),
      v.maxLength(BROWSER_CONTROL_LIMITS.urlChars),
    ),
  }),
  aggregateMutation: {
    type: "aggregate",
    aggregates: ["chatToolGrants"],
  },
} satisfies HandlerConfig;

/**
 * Remove every research note the member keeps for one website, from
 * Settings. Idempotent: a website without notes answers `deleted: 0`.
 */
const deleteBrowserSiteNotesSite = createSafeRootHandler(
  config,
  async function* ({
    query: { url },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const origin = browserSiteGrantOrigin(url);
    if (origin === null) {
      return Result.err(
        new HandlerError({
          code: BROWSER_SITE_NOTE_REFUSAL_CODE.notHttps,
          status: 422,
          message: "Only an HTTPS website has research notes",
        }),
      );
    }
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        // The member's collection lock, shared with their website approvals.
        await withAggregateLock({ tx, aggregate: "chatToolGrants", id: owner });
        return await deleteBrowserSiteNotesForSiteOnTx(tx, {
          origin,
          owner,
          recordAuditEvent,
        });
      }),
    );
    return Result.ok(deleted);
  },
);

export default deleteBrowserSiteNotesSite;
