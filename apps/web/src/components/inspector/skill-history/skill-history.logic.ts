import type { TranslationKey } from "@/i18n/types";
import type {
  skillCommentsOptions,
  skillProposalsOptions,
  skillRevisionsOptions,
} from "@/lib/knowledge/queries";
import { managementRoles } from "@/lib/organization/consts";

// Row shapes are derived from the query factories rather than restated, so a
// server-side field rename fails to compile here instead of drifting.
export type SkillRevisionSummary = Awaited<
  ReturnType<NonNullable<ReturnType<typeof skillRevisionsOptions>["queryFn"]>>
>["items"][number];

export type SkillProposalSummary = Awaited<
  ReturnType<NonNullable<ReturnType<typeof skillProposalsOptions>["queryFn"]>>
>["items"][number];

export type SkillCommentRow = Awaited<
  ReturnType<NonNullable<ReturnType<typeof skillCommentsOptions>["queryFn"]>>
>["items"][number];

/**
 * Authoring statuses a proposal moves through. Mirrors the API's
 * `agentSkillProposals.status`; the mirror is bound at compile time because
 * every consumer indexes {@link PROPOSAL_STATUS_LABEL_KEY} with the status the
 * Eden client returns, so a new server-side status fails to typecheck here
 * rather than falling through to a default label.
 */
export const SKILL_PROPOSAL_STATUSES = [
  "draft",
  "proposed",
  "accepted",
  "rejected",
] as const;

export type SkillProposalStatus = (typeof SKILL_PROPOSAL_STATUSES)[number];

export const PROPOSAL_STATUS_LABEL_KEY = {
  draft: "skillHistory.statusDraft",
  proposed: "skillHistory.statusProposed",
  accepted: "skillHistory.statusAccepted",
  rejected: "skillHistory.statusRejected",
} as const satisfies Record<SkillProposalStatus, TranslationKey>;

/** Still awaiting a decision, so it counts towards the toolbar's open badge. */
export const isOpenProposalStatus = (status: SkillProposalStatus): boolean =>
  status === "draft" || status === "proposed";

// Bodies that ship with the product are replaced wholesale on update, so the
// API refuses proposals against them.
const NON_AUTHORED_ORIGINS = ["built-in", "bundled"] as const;

export const isProposableOrigin = (origin: string): boolean =>
  !NON_AUTHORED_ORIGINS.some(
    (nonAuthoredOrigin) => nonAuthoredOrigin === origin,
  );

type CanManageSkillOptions = {
  scope: "team" | "private";
  /** Owner of a private skill; null for team skills. */
  ownerUserId: string | null;
  /** The signed-in user's role in the active organization, once loaded. */
  memberRole: string | undefined;
  userId: string;
};

/**
 * Who may edit a skill directly and decide proposals on it. Mirrors the API's
 * `canManageSkill`: an org admin or owner for a team skill, the owner for a
 * private one. The server enforces the same rule; this only decides which
 * affordances are worth rendering.
 */
export const canManageSkill = ({
  scope,
  ownerUserId,
  memberRole,
  userId,
}: CanManageSkillOptions): boolean => {
  switch (scope) {
    case "team":
      return managementRoles.some(
        (managementRole) => managementRole === memberRole,
      );
    case "private":
      return ownerUserId === userId;
  }
};

type OrganizationMember = {
  userId: string;
  user: { name?: string | null | undefined; email: string };
};

/** Resolves the display name of a revision, proposal, or comment author. */
export type MemberNameLookup = (userId: string | null) => string;

type MemberNameLookupOptions = {
  members: readonly OrganizationMember[] | undefined;
  /** Shown for system writes and for authors no longer in the organization. */
  fallback: string;
};

export const createMemberNameLookup = ({
  members,
  fallback,
}: MemberNameLookupOptions): MemberNameLookup => {
  const names = new Map(
    (members ?? []).map((member) => [
      member.userId,
      member.user.name?.trim() || member.user.email,
    ]),
  );

  return (userId) =>
    userId === null ? fallback : (names.get(userId) ?? fallback);
};
