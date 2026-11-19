import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  member,
  organizationSsoPolicy,
  session,
  ssoProvider,
} from "@/api/db/auth-schema";
import type {
  MemberAuthentication,
  SsoAccess,
} from "@/api/lib/auth/member-authorization";
import { SSO_ACCESS_STATUS } from "@/api/lib/auth/member-authorization";
import { isEnterpriseSsoDeployed } from "@/api/lib/auth/sso-sign-in";

const constantStatus = (
  status: SsoAccess["status"],
): SQL<SsoAccess["status"]> => sql<SsoAccess["status"]>`${status}::text`;

/**
 * The organization's SSO requirement against the caller, as one column of
 * the member lookup: the policy row and the session and provider rows are
 * each read by primary key, and the provider's sealed configuration is never
 * selected. A browser session satisfies a requirement only while it is live
 * and was created by a provider that still belongs to the organization, so
 * deleting or moving a provider ends what its sessions reach.
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
        when not exists (
          select 1 from ${organizationSsoPolicy}
          where ${organizationSsoPolicy.organizationId} = ${member.organizationId}
            and ${organizationSsoPolicy.requirement} = 'required'
        ) then ${SSO_ACCESS_STATUS.notRequired}::text
        when exists (
          select 1 from ${session}
          inner join ${ssoProvider} on ${ssoProvider.id} = ${session.ssoProviderId}
          where ${session.id} = ${authentication.sessionId}
            and ${session.userId} = ${member.userId}
            and ${session.expiresAt} > now()
            and ${ssoProvider.organizationId} = ${member.organizationId}
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
