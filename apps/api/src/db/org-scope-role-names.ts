import type { OrgScopeActor } from "./org-scope";
import { SYSTEM_RLS_ROLE_NAME } from "./rls";
import {
  APPLICATION_RLS_ROLE_NAME,
  CORRESPONDENCE_OFFBOARDING_ROLE_NAME,
  FOLIO_COLLAB_TOKEN_OFFBOARDING_ROLE_NAME,
  MEMBER_EXCHANGE_OFFBOARDING_ROLE_NAME,
  MEMBER_REMOVAL_ROLE_NAME,
  REVIEW_RESET_ROLE_NAME,
  WORKSPACE_SEARCH_ACTIVITY_ROLE_NAME,
} from "./role-names";

/** Every privileged organization intent selects one declared database role. */
export const ORG_SCOPE_ROLE_NAMES = {
  system: SYSTEM_RLS_ROLE_NAME,
  "workspace-search-activity": WORKSPACE_SEARCH_ACTIVITY_ROLE_NAME,
  "review-reset": REVIEW_RESET_ROLE_NAME,
  "member-removal": MEMBER_REMOVAL_ROLE_NAME,
  "member-exchange-offboarding": MEMBER_EXCHANGE_OFFBOARDING_ROLE_NAME,
  "correspondence-offboarding": CORRESPONDENCE_OFFBOARDING_ROLE_NAME,
  "folio-collab-token-offboarding": FOLIO_COLLAB_TOKEN_OFFBOARDING_ROLE_NAME,
} as const satisfies Record<Exclude<OrgScopeActor["type"], "actor">, string>;

export const SCOPED_TRANSACTION_ROLE_NAMES = {
  application: APPLICATION_RLS_ROLE_NAME,
  ...ORG_SCOPE_ROLE_NAMES,
} as const;
