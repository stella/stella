import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL, SQLWrapper } from "drizzle-orm";

import {
  member,
  organizationSsoPolicy,
  session,
  ssoProvider,
} from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type {
  MemberAuthentication,
  SsoAccess,
} from "@/api/lib/auth/member-authorization";
import { SSO_ACCESS_STATUS } from "@/api/lib/auth/member-authorization";
import { liveSessionPredicate } from "@/api/lib/auth/session-liveness";
import type { SafeId } from "@/api/lib/branded-types";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { typedPgArray } from "@/api/lib/search/sql";

/**
 * The one SSO decision. Every surface that admits a member of an
 * organization (member routes, the organization plugin's endpoints, OAuth
 * grant issuance and event streams) builds its check from the predicates
 * here, so none of them can admit a session another refuses.
 *
 * An organization with a `required` policy admits only a session one of its
 * providers created. Provider rows never change issuer or organization (a
 * trigger refuses it), so the session's provider row id names one provider
 * generation: deleting or replacing a provider ends what its sessions reach.
 */

/** Whether organization SSO is deployed; read per call like every flag. */
export const isEnterpriseSsoDeployed = (): boolean =>
  isDeploymentFeatureEnabled("FEATURE_ENTERPRISE_SSO");

/** Whether the organization requires SSO; reads the policy row by key. */
const organizationRequiresSso = (
  organizationId: SQLWrapper | SafeId<"organization">,
): SQL =>
  sql`exists (
    select 1 from ${organizationSsoPolicy}
    where ${organizationSsoPolicy.organizationId} = ${organizationId}
      and ${organizationSsoPolicy.requirement} = 'required'
  )`;

/** Whether a session's recorded provider row belongs to the organization. */
const providerOfOrganization = (
  sessionProviderId: SQLWrapper,
  organizationId: SQLWrapper | SafeId<"organization">,
): SQL =>
  sql`exists (
    select 1 from ${ssoProvider}
    where ${ssoProvider.id} = ${sessionProviderId}
      and ${ssoProvider.organizationId} = ${organizationId}
  )`;

/**
 * A boolean condition on a joined `session` row: the organization admits it.
 * True for every session while SSO is not deployed. The caller keeps its own
 * liveness and membership conditions.
 */
export const ssoAdmitsSession = (organizationId: SQLWrapper): SQL<boolean> =>
  isEnterpriseSsoDeployed()
    ? sql<boolean>`(not ${organizationRequiresSso(organizationId)} or ${providerOfOrganization(session.ssoProviderId, organizationId)})`
    : sql<boolean>`true`;

const constantStatus = (
  status: SsoAccess["status"],
): SQL<SsoAccess["status"]> => sql<SsoAccess["status"]>`${status}::text`;

/**
 * The organization's SSO requirement against the caller, as one column of
 * the member lookup: the policy row and the session and provider rows are
 * each read by primary key, and the provider's sealed configuration is never
 * selected. A browser session satisfies a requirement only while it is live.
 */
export const ssoAccessColumn = (
  authentication: MemberAuthentication,
): SQL<SsoAccess["status"]> => {
  if (!isEnterpriseSsoDeployed()) {
    return constantStatus(SSO_ACCESS_STATUS.notRequired);
  }
  switch (authentication.kind) {
    case "credential":
      return constantStatus(SSO_ACCESS_STATUS.notEvaluated);
    case "browser_session":
      return sql<SsoAccess["status"]>`case
        when not ${organizationRequiresSso(member.organizationId)}
          then ${SSO_ACCESS_STATUS.notRequired}::text
        when exists (
          select 1 from ${session}
          where ${session.id} = ${authentication.sessionId}
            and ${session.userId} = ${member.userId}
            and ${liveSessionPredicate(new Date(), session)}
            and ${providerOfOrganization(session.ssoProviderId, member.organizationId)}
        ) then ${SSO_ACCESS_STATUS.satisfied}::text
        else ${SSO_ACCESS_STATUS.signInRequired}::text
      end`;
    default:
      authentication satisfies never;
      return panic("Unhandled member authentication");
  }
};

const SSO_ACCESS_STATUSES: readonly string[] = Object.values(SSO_ACCESS_STATUS);

const isSsoAccessStatus = (status: string): status is SsoAccess["status"] =>
  SSO_ACCESS_STATUSES.includes(status);

/** The column read back; an unknown value refuses rather than admits. */
export const ssoAccessOf = (status: string): SsoAccess => ({
  status: isSsoAccessStatus(status) ? status : SSO_ACCESS_STATUS.signInRequired,
});

type SsoDecisionDb = Pick<Transaction, "execute">;

type SessionSsoLookup = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The session the access derives from; null when none is left. */
  sessionId: string | null;
  /**
   * `live`: the session must still be live (an interactive request).
   * `recorded`: its row must still exist, live or expired, so a grant minted
   * from it keeps the provenance it was minted with until the row is gone.
   */
  session: "live" | "recorded";
};

/**
 * The organization's SSO decision for a session outside the member lookup:
 * the organization plugin's endpoints and OAuth grant issuance. A session
 * that is gone, or none, never satisfies a requirement.
 */
export const readSessionSsoAccess = async (
  db: SsoDecisionDb,
  { organizationId, userId, sessionId, session: liveness }: SessionSsoLookup,
): Promise<SsoAccess> => {
  if (!isEnterpriseSsoDeployed()) {
    return { status: SSO_ACCESS_STATUS.notRequired };
  }
  const live =
    liveness === "live"
      ? sql`and ${liveSessionPredicate(new Date(), session)}`
      : sql``;
  const rows = await db.execute<{ status: string }>(sql`
    select case
      when not ${organizationRequiresSso(organizationId)}
        then ${SSO_ACCESS_STATUS.notRequired}::text
      when exists (
        select 1 from ${session}
        where ${session.id} = ${sessionId}
          and ${session.userId} = ${userId}
          ${live}
          and ${providerOfOrganization(session.ssoProviderId, organizationId)}
      ) then ${SSO_ACCESS_STATUS.satisfied}::text
      else ${SSO_ACCESS_STATUS.signInRequired}::text
    end as status
  `);
  const status = rows.at(0)?.status;
  return status === undefined
    ? panic("The SSO decision returned no row")
    : ssoAccessOf(status);
};

/**
 * Whether any of `organizationIds` requires SSO and refuses the session, in
 * one statement: the organization endpoints act on every organization a
 * request names.
 */
export const ssoRefusesSessionInAny = async (
  db: SsoDecisionDb,
  {
    organizationIds,
    userId,
    sessionId,
  }: Omit<SessionSsoLookup, "organizationId" | "session"> & {
    organizationIds: readonly SafeId<"organization">[];
  },
): Promise<boolean> => {
  if (!isEnterpriseSsoDeployed() || organizationIds.length === 0) {
    return false;
  }
  const requested = sql`requested.organization_id`;
  const rows = await db.execute<{ refused: boolean }>(sql`
    select exists (
      select 1
      from unnest(${typedPgArray(organizationIds, "text")}) as requested(organization_id)
      where ${organizationRequiresSso(requested)}
        and not exists (
          select 1 from ${session}
          where ${session.id} = ${sessionId}
            and ${session.userId} = ${userId}
            and ${liveSessionPredicate(new Date(), session)}
            and ${providerOfOrganization(session.ssoProviderId, requested)}
        )
    ) as refused
  `);
  return rows.at(0)?.refused ?? panic("The SSO decision returned no row");
};
