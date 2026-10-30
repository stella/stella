import { Result } from "better-result";
import * as v from "valibot";

import { ORGANIZATION_SLUG_RULES } from "@stll/auth-model";

import { consumeOrganizationSlugRateLimit } from "@/api/handlers/organizations/slug/rate-limit";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { changeOrganizationSlug } from "@/api/lib/db/organization-slug";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const OPAQUE_SUFFIX_LENGTH = 10;
const opaqueSlug = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(OPAQUE_SUFFIX_LENGTH));
  return `org-${Array.from(bytes, (byte) => BASE32_ALPHABET.charAt(byte % 32)).join("")}`;
};

const config = {
  contract: "patch",
  description:
    "Change the active organization's slug. Owners and admins may choose a lowercase slug or generate an opaque org- identifier. The old slug has no alias. A taken slug returns organization_slug_conflict; choose another or use type opaque.",
  permissions: { organization: ["update"] },
  accountAccess: ACCOUNT_ACCESS.accountControl,
  mcp: {
    type: "capability",
    reason: "organization_admin",
    consumesServices: false,
  },
  body: v.variant("type", [
    v.strictObject({
      type: v.literal("explicit"),
      slug: v.pipe(
        v.string(),
        v.minLength(ORGANIZATION_SLUG_RULES.minLength),
        v.maxLength(ORGANIZATION_SLUG_RULES.maxLength),
        v.regex(ORGANIZATION_SLUG_RULES.pattern),
      ),
    }),
    v.strictObject({ type: v.literal("opaque") }),
  ]),
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ body, session, user, memberRole, recordAuditEvent }) {
    if (session.credentialType === "agent_run") {
      return Result.err(
        new HandlerError({
          status: 403,
          code: "agent_run_refused",
          message:
            "Change the organization slug with an owner or admin credential outside an agent run.",
        }),
      );
    }
    if (
      !(await consumeOrganizationSlugRateLimit(session.activeOrganizationId))
    ) {
      return Result.err(
        new HandlerError({
          status: 429,
          code: "rate_limited",
          message: "Too many organization slug changes. Retry in one minute.",
        }),
      );
    }
    const updated = yield* Result.await(
      changeOrganizationSlug({
        organizationId: session.activeOrganizationId,
        userId: user.id,
        memberRole,
        slug: body.type === "opaque" ? opaqueSlug() : body.slug,
        recordAuditEvent,
      }),
    );
    return Result.ok(updated);
  },
);
