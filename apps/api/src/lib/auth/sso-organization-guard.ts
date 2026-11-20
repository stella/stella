import type { BetterAuthPlugin } from "@better-auth/core";
import { createAuthMiddleware } from "@better-auth/core/api";
import { APIError } from "@better-auth/core/error";
import type { getEndpoints } from "better-auth/api";
import { getSessionFromCtx } from "better-auth/api";
import { inArray } from "drizzle-orm";

import { SSO_SIGN_IN_REQUIRED_CODE } from "@stll/api-contract/sso";

import { invitation, organization } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import type { getAuth } from "@/api/lib/auth";
import { SSO_ACCESS_STATUS } from "@/api/lib/auth/member-authorization";
import {
  isEnterpriseSsoDeployed,
  readSessionSsoAccess,
  ssoRefusesSessionInAny,
} from "@/api/lib/auth/sso-access";
import type { SafeId } from "@/api/lib/branded-types";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/**
 * The SSO refusals better-auth's own endpoints raise: the organization
 * endpoints, OAuth consent and OAuth token issuance. Each asks the shared
 * decision in `sso-access.ts`. The organization endpoints and consent run
 * outside any request transaction and read on the owner connection; token
 * issuance decides inside the transaction that issues the token.
 */

const ORGANIZATION_PATH_PREFIX = "/organization/";

const SSO_SIGN_IN_REQUIRED_MESSAGE =
  "This organization requires signing in with its SSO provider.";

type SsoGuardDatabase = Pick<Transaction, "execute" | "select">;

type RegisteredAuthApi = ReturnType<
  typeof getEndpoints<ReturnType<typeof getAuth>["options"]>
>["api"];
/** Every organization endpoint the auth layer registers. */
type OrganizationEndpointPath = Extract<
  Exclude<RegisteredAuthApi[keyof RegisteredAuthApi]["path"], undefined>,
  `/organization/${string}`
>;
type OrganizationEndpointSso = "organization" | "recovery";

/**
 * How each organization endpoint meets the SSO decision. `organization`:
 * the endpoint reads or changes an organization, so every organization the
 * request names, and the session's active one, must admit the session.
 * `recovery`: the endpoint is how a refused session finds its way back
 * (listing its organizations, switching the active one, answering an
 * invitation), so it stays open. A path missing here is held to
 * `organization`.
 */
export const ORGANIZATION_ENDPOINT_SSO = {
  "/organization/set-active": "recovery",
  "/organization/list": "recovery",
  "/organization/check-slug": "recovery",
  "/organization/accept-invitation": "recovery",
  "/organization/reject-invitation": "recovery",
  "/organization/get-invitation": "recovery",
  "/organization/list-user-invitations": "recovery",
  "/organization/create": "recovery",
  "/organization/update": "organization",
  "/organization/delete": "organization",
  "/organization/get-organization": "organization",
  "/organization/get-full-organization": "organization",
  "/organization/invite-member": "organization",
  "/organization/cancel-invitation": "organization",
  "/organization/list-invitations": "organization",
  "/organization/get-active-member": "organization",
  "/organization/get-active-member-role": "organization",
  "/organization/remove-member": "organization",
  "/organization/update-member-role": "organization",
  "/organization/list-members": "organization",
  "/organization/has-permission": "organization",
  "/organization/leave": "organization",
} as const satisfies Record<OrganizationEndpointPath, OrganizationEndpointSso>;

const ENDPOINT_SSO_BY_PATH: ReadonlyMap<string, OrganizationEndpointSso> =
  new Map(Object.entries(ORGANIZATION_ENDPOINT_SSO));

const isRecoveryEndpoint = (path: string): boolean =>
  ENDPOINT_SSO_BY_PATH.get(path) === "recovery";

const stringField = (source: unknown, field: string): string | undefined => {
  const value = isRecord(source) ? source[field] : undefined;
  return typeof value === "string" && value !== "" ? value : undefined;
};

/**
 * Every organization the request can act on: those it names by id, by slug
 * or through an invitation, and the session's active organization, which
 * several endpoints use whatever the request names.
 */
const requestOrganizations = async (
  db: SsoGuardDatabase,
  input: { body: unknown; query: unknown },
  activeOrganizationId: string | undefined,
): Promise<ReadonlySet<string>> => {
  const named = [
    stringField(input.body, "organizationId"),
    stringField(input.query, "organizationId"),
    activeOrganizationId,
  ].filter((id): id is string => id !== undefined);
  const slugs = [
    stringField(input.body, "organizationSlug"),
    stringField(input.query, "organizationSlug"),
  ].filter((slug): slug is string => slug !== undefined);
  const invitationIds = [
    stringField(input.body, "invitationId"),
    stringField(input.query, "invitationId"),
  ].filter((id): id is string => id !== undefined);
  const bySlug =
    slugs.length === 0
      ? []
      : await db
          .select({ id: organization.id })
          .from(organization)
          .where(inArray(organization.slug, slugs))
          .limit(slugs.length);
  const byInvitation =
    invitationIds.length === 0
      ? []
      : await db
          .select({ id: invitation.organizationId })
          .from(invitation)
          .where(inArray(invitation.id, invitationIds))
          .limit(invitationIds.length);
  return new Set([
    ...named,
    ...bySlug.map(({ id }) => id),
    ...byInvitation.map(({ id }) => id),
  ]);
};

/**
 * Holds the organization plugin's endpoints to the same SSO decision as the
 * product's routes: a session an organization's SSO requirement refuses can
 * neither read nor change that organization through them. The session is
 * not ended, and the recovery endpoints stay open.
 */
export const createSsoOrganizationGuardPlugin = () =>
  ({
    id: "stella-sso-organization-guard",
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path?.startsWith(ORGANIZATION_PATH_PREFIX) ?? false,
          handler: createAuthMiddleware(async (ctx) => {
            if (!isEnterpriseSsoDeployed() || ctx.path === undefined) {
              return;
            }
            if (isRecoveryEndpoint(ctx.path)) {
              return;
            }
            const current = await getSessionFromCtx(ctx);
            if (current === null) {
              return;
            }
            const active: unknown = current.session["activeOrganizationId"];
            const organizations = await requestOrganizations(
              rootDb,
              { body: ctx.body, query: ctx.query },
              typeof active === "string" && active !== "" ? active : undefined,
            );
            const refused = await ssoRefusesSessionInAny(rootDb, {
              organizationIds: [...organizations].map((id) =>
                brandPersistedOrganizationId(id),
              ),
              userId: brandPersistedUserId(current.user.id),
              sessionId: current.session.id,
            });
            if (refused) {
              throw new APIError("FORBIDDEN", {
                code: SSO_SIGN_IN_REQUIRED_CODE,
                message: SSO_SIGN_IN_REQUIRED_MESSAGE,
              });
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

type SessionGrantLookup = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  sessionId: string | null;
};

/**
 * Consent grants an organization only to a live session it admits; token
 * issuance checks the same decision again.
 */
export const refuseConsentUnlessSsoAdmits = async (
  lookup: SessionGrantLookup,
): Promise<void> => {
  const access = await readSessionSsoAccess(rootDb, {
    ...lookup,
    session: "live",
  });
  if (access.status === SSO_ACCESS_STATUS.signInRequired) {
    throw new APIError("FORBIDDEN", {
      error: SSO_SIGN_IN_REQUIRED_CODE,
      message: SSO_SIGN_IN_REQUIRED_MESSAGE,
    });
  }
};

/**
 * Every organization token, first issue and refresh alike, carries the SSO
 * provenance of the browser session that granted it: an organization that
 * requires SSO refuses a token whose session no provider of its created, or
 * whose session row is gone.
 */
export const refuseTokenUnlessSsoAdmits = async (
  tx: SsoGuardDatabase,
  lookup: SessionGrantLookup,
): Promise<void> => {
  const access = await readSessionSsoAccess(tx, {
    ...lookup,
    session: "recorded",
  });
  if (access.status === SSO_ACCESS_STATUS.signInRequired) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_grant",
      error_description: SSO_SIGN_IN_REQUIRED_MESSAGE,
    });
  }
};
