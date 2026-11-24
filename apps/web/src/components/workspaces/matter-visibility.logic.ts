import { panic } from "better-result";

import {
  defaultMatterVisibilityFor,
  widensMatterVisibility,
} from "@stll/api-contract/matter-visibility";
import type {
  MATTER_VISIBILITY,
  MatterVisibility,
} from "@stll/api-contract/matter-visibility";

import type { TranslationKey } from "@/i18n/types";
import { hasOrganizationManagementAccess } from "@/lib/organization/role-assignment.logic";

type MatterVisibilityCopy = {
  label: TranslationKey;
  description: TranslationKey;
};

export const MATTER_VISIBILITY_COPY = {
  all_members: {
    label: "workspaces.visibility.allMembers",
    description: "workspaces.visibility.allMembersDescription",
  },
  admins_and_assigned: {
    label: "workspaces.visibility.adminsAndAssigned",
    description: "workspaces.visibility.adminsAndAssignedDescription",
  },
  assigned_only: {
    label: "workspaces.visibility.assignedOnly",
    description: "workspaces.visibility.assignedOnlyDescription",
  },
} as const satisfies Record<MatterVisibility, MatterVisibilityCopy>;

/**
 * Who gains access when a matter is widened to each level. `assigned_only`
 * is the narrowest level, so nothing widens to it.
 */
export const MATTER_VISIBILITY_WIDENING_AUDIENCE = {
  all_members: "workspaces.visibility.widenToAllMembers",
  admins_and_assigned: "workspaces.visibility.widenToAdminsAndAssigned",
} as const satisfies Record<
  Exclude<MatterVisibility, typeof MATTER_VISIBILITY.assignedOnly>,
  TranslationKey
>;

type MatterVisibilityWideningTarget =
  keyof typeof MATTER_VISIBILITY_WIDENING_AUDIENCE;

const isWideningTarget = (
  visibility: MatterVisibility,
): visibility is MatterVisibilityWideningTarget =>
  Object.hasOwn(MATTER_VISIBILITY_WIDENING_AUDIENCE, visibility);

type MatterVisibilityEditorOptions = {
  canUpdateMatters: boolean;
  role: string | undefined;
  userId: string;
  leadUserId: string | null;
};

/**
 * Mirrors the API's rule for who may change a matter's visibility: someone
 * whose role can update matters and who either leads this matter or is an
 * organization owner or admin. A lead whose role cannot update matters (an
 * intern or external lead) may not.
 */
export const canChangeMatterVisibility = ({
  canUpdateMatters,
  role,
  userId,
  leadUserId,
}: MatterVisibilityEditorOptions): boolean =>
  canUpdateMatters &&
  (leadUserId === userId || hasOrganizationManagementAccess(role));

export type MatterVisibilityChange =
  | { type: "unchanged" }
  | { type: "narrow"; visibility: MatterVisibility }
  | { type: "widen"; visibility: MatterVisibilityWideningTarget };

type MatterVisibilityChangeOptions = {
  from: MatterVisibility;
  to: MatterVisibility;
};

/** A widening shows the matter to people who cannot see it now, so it is confirmed first. */
export const matterVisibilityChange = ({
  from,
  to,
}: MatterVisibilityChangeOptions): MatterVisibilityChange => {
  if (from === to) {
    return { type: "unchanged" };
  }
  if (!widensMatterVisibility(from, to)) {
    return { type: "narrow", visibility: to };
  }
  return isWideningTarget(to)
    ? { type: "widen", visibility: to }
    : panic(`Matter visibility widened to the narrowest level: ${to}`);
};

/**
 * A new matter's visibility follows its client until the person picks a
 * level; after that the pick stands whatever happens to the client field.
 */
export type NewMatterVisibilityChoice =
  { type: "followClient" } | { type: "chosen"; visibility: MatterVisibility };

export const FOLLOW_CLIENT_VISIBILITY: NewMatterVisibilityChoice = {
  type: "followClient",
};

type NewMatterVisibilityOptions = {
  choice: NewMatterVisibilityChoice;
  hasClient: boolean;
};

export const newMatterVisibility = ({
  choice,
  hasClient,
}: NewMatterVisibilityOptions): MatterVisibility => {
  switch (choice.type) {
    case "followClient":
      return defaultMatterVisibilityFor({ hasClient });
    case "chosen":
      return choice.visibility;
    default:
      choice satisfies never;
      return panic("Unhandled new matter visibility choice");
  }
};
