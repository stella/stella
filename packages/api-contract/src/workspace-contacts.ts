export const CONTACT_TYPES = ["person", "organization"] as const;

export type ContactType = (typeof CONTACT_TYPES)[number];

export const WORKSPACE_CONTACT_ROLES = [
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

export type WorkspaceContactRole = (typeof WORKSPACE_CONTACT_ROLES)[number];
