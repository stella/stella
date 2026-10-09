import type { DataTag } from "@tanstack/react-query";

import type { sessionOptions } from "@/lib/auth-query-options";

type SessionData =
  typeof sessionOptions.queryKey extends DataTag<unknown, infer TData, unknown>
    ? NonNullable<TData>
    : never;

const SIGNED_AT = new Date("2026-01-01T00:00:00Z");
export const MEMBER_SESSION = {
  session: {
    activeOrganizationId: "org_1",
    createdAt: SIGNED_AT,
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    id: "session_1",
    token: "token",
    updatedAt: SIGNED_AT,
    userId: "user_1",
  },
  user: {
    createdAt: SIGNED_AT,
    email: "member@example.test",
    emailVerified: true,
    id: "user_1",
    name: "Member",
    timezoneId: "UTC",
    twoFactorEnabled: false,
    updatedAt: SIGNED_AT,
  },
} satisfies SessionData;
