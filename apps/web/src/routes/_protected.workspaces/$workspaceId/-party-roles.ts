export const PARTY_ROLES = [
  "opposing_party",
  "opposing_counsel",
  "co_counsel",
  "witness",
  "expert_witness",
  "third_party",
  "judge",
  "mediator",
  "other",
] as const;

export type PartyRole = (typeof PARTY_ROLES)[number];

const PARTY_ROLES_SET = new Set<string>(PARTY_ROLES);

const isPartyRole = (value: string): value is PartyRole =>
  PARTY_ROLES_SET.has(value);

export const toPartyRole = (value: string): PartyRole | null =>
  isPartyRole(value) ? value : null;
