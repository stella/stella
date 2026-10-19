import type { member, user } from "@/api/db/auth-schema";

/** The user's profile fields, excluding auth credentials and two-factor secrets. */
export const projectAccountProfile = (
  row: Pick<
    typeof user.$inferSelect,
    | "id"
    | "name"
    | "email"
    | "emailVerified"
    | "image"
    | "timezoneId"
    | "preferredName"
    | "wordEditShortcut"
    | "userShortcuts"
    | "guideProgress"
    | "detectedCountry"
    | "createdAt"
    | "updatedAt"
  >,
) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  emailVerified: row.emailVerified,
  image: row.image,
  timezoneId: row.timezoneId,
  preferredName: row.preferredName,
  wordEditShortcut: row.wordEditShortcut,
  userShortcuts: row.userShortcuts,
  guideProgress: row.guideProgress,
  detectedCountry: row.detectedCountry,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/** Membership facts without organization row content. */
export const projectAccountMembership = ({
  id,
  organizationId,
  role,
  createdAt,
}: Pick<
  typeof member.$inferSelect,
  "id" | "organizationId" | "role" | "createdAt"
>) => ({
  id,
  organizationId,
  role,
  createdAt: createdAt.toISOString(),
});
