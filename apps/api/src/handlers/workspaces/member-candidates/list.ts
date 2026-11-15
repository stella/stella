import { panic, Result } from "better-result";
import { and, asc, eq, isNull } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { readBounded } from "@/api/lib/db/read-bounded";
import { LIMITS } from "@/api/lib/limits";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type MemberRow = typeof member.$inferSelect;
type UserRow = typeof user.$inferSelect;

const UNPROJECTED_MEMBER_COLUMNS = [
  // Membership row identity is not needed to choose a person.
  "id",
  // The read is scoped to the caller's organization.
  "organizationId",
  // A matter is shared with a person whatever their organization role.
  "role",
  // Per-user navigation state, not part of a colleague's card.
  "lastActiveWorkspaceId",
  // When they joined is not shown in a picker.
  "createdAt",
] as const satisfies readonly (keyof MemberRow)[];

const MEMBER_CANDIDATE_COLUMNS = { userId: member.userId } as const;

const UNPROJECTED_USER_PROFILE_COLUMNS = [
  // Identity is projected from member.userId, joined to user.id.
  "id",
  // Authentication state is not part of a colleague's card.
  "emailVerified",
  // Time formatting preferences are not used by a picker.
  "timezoneId",
  // A picker uses the canonical name, as other matter-team surfaces do.
  "preferredName",
  // Editor shortcut preferences are unrelated to choosing a person.
  "wordEditShortcut",
  // Answer language is a private reading preference.
  "readerAnswerLanguage",
  // Keyboard rebindings belong to the user's settings.
  "userShortcuts",
  // Onboarding progress belongs to the signed-in user's session.
  "guideProgress",
  // Signup geography is not needed to identify a colleague.
  "detectedCountry",
  // Two-factor configuration is private authentication state.
  "twoFactorEnabled",
  // Filtered on: a deleted account is not offered.
  "deletedAt",
  // Registration time is not shown in a picker.
  "createdAt",
  // Profile modification time is not shown in a picker.
  "updatedAt",
  // Mail provider refusals are account delivery state, not a display profile.
  "emailUndeliverableAddress",
  "emailUndeliverableReason",
  "emailUndeliverableAt",
] as const satisfies readonly (keyof UserRow)[];

const USER_PROFILE_COLUMNS = {
  name: user.name,
  email: user.email,
  image: user.image,
} as const;

type MissingProjectedMemberColumn = UnprojectedColumns<
  MemberRow,
  typeof MEMBER_CANDIDATE_COLUMNS,
  (typeof UNPROJECTED_MEMBER_COLUMNS)[number]
>;
type UnexpectedProjectedMemberColumn = UnbackedProjectionKeys<
  MemberRow,
  typeof MEMBER_CANDIDATE_COLUMNS,
  (typeof UNPROJECTED_MEMBER_COLUMNS)[number]
>;
type MissingProjectedUserProfileColumn = UnprojectedColumns<
  UserRow,
  typeof USER_PROFILE_COLUMNS,
  (typeof UNPROJECTED_USER_PROFILE_COLUMNS)[number]
>;
type UnexpectedProjectedUserProfileColumn = UnbackedProjectionKeys<
  UserRow,
  typeof USER_PROFILE_COLUMNS,
  (typeof UNPROJECTED_USER_PROFILE_COLUMNS)[number]
>;

true satisfies MissingProjectedMemberColumn extends never ? true : never;
true satisfies UnexpectedProjectedMemberColumn extends never ? true : never;
true satisfies MissingProjectedUserProfileColumn extends never ? true : never;
true satisfies UnexpectedProjectedUserProfileColumn extends never
  ? true
  : never;

const config = {
  contract: "patch",
  description:
    "List the people of the caller's organization a matter can be shared " +
    "with, each with their user id, name, email and image, ordered by name. " +
    "Pass a userId to matters.create's memberUserIds or to " +
    "matters.members.add.",
  // The firm directory is for those who share matters: a read-only
  // collaborator, such as an external or an intern, gets no list of people.
  permissions: { workspace: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "organization_management",
    consumesServices: false,
  },
  access: "read",
} satisfies HandlerConfig;

/**
 * `GET /v1/workspaces/member-candidates`: the organization's members, the
 * people a new or existing matter can be given to. Deleted accounts are left
 * out, as a matter cannot be shared with them.
 */
const listWorkspaceMemberCandidates = createSafeRootHandler(
  config,
  async function* ({ safeDb, session }) {
    const members = yield* Result.await(
      safeDb(async (tx) => {
        // The organization's membership limit bounds the list; one page
        // keeps a picker's whole choice in one answer.
        const read = await readBounded(
          tx
            .select({ ...MEMBER_CANDIDATE_COLUMNS, ...USER_PROFILE_COLUMNS })
            .from(member)
            .innerJoin(user, eq(user.id, member.userId))
            .where(
              and(
                eq(member.organizationId, session.activeOrganizationId),
                isNull(user.deletedAt),
              ),
            )
            .orderBy(asc(user.name), asc(member.userId)),
          LIMITS.organizationMembersCount,
        );
        if (read.type === "overflow") {
          return panic("Organization members exceed the membership limit");
        }
        return read.rows;
      }),
    );

    return Result.ok({ members });
  },
);

export default listWorkspaceMemberCandidates;
