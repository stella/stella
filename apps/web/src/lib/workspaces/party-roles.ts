import {
  WORKSPACE_CONTACT_ROLES,
  type WorkspaceContactRole,
} from "@stll/api-contract";

import type { TranslationKey } from "@/i18n/types";

export const PARTY_ROLES = WORKSPACE_CONTACT_ROLES;

export type PartyRole = WorkspaceContactRole;

export const PARTY_ROLE_LABEL_KEYS = {
  opposing_party: "workspaces.parties.partyRoles.opposing_party",
  opposing_counsel: "workspaces.parties.partyRoles.opposing_counsel",
  co_counsel: "workspaces.parties.partyRoles.co_counsel",
  witness: "workspaces.parties.partyRoles.witness",
  expert_witness: "workspaces.parties.partyRoles.expert_witness",
  third_party: "workspaces.parties.partyRoles.third_party",
  judge: "workspaces.parties.partyRoles.judge",
  mediator: "workspaces.parties.partyRoles.mediator",
  other: "workspaces.parties.partyRoles.other",
} as const satisfies Record<PartyRole, TranslationKey>;

const isPartyRole = (value: string): value is PartyRole =>
  PARTY_ROLES.some((role) => role === value);

export const toPartyRole = (value: string): PartyRole | null =>
  isPartyRole(value) ? value : null;
