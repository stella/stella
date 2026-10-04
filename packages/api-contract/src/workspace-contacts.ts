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

export const MATTER_CONTACT_CAPACITY_CODE = {
  reached: "matter_contact_capacity_reached",
  exceeded: "matter_contact_capacity_exceeded",
} as const;
