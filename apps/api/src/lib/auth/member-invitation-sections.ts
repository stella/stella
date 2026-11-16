import type { BetterAuthPlugin } from "better-auth";
import type { createAuthMiddleware } from "better-auth/api";
import { panic } from "better-result";

import {
  classifyInvitation,
  isInvitationStatus,
} from "@stll/auth-model/invitation-sections";

import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

const FULL_ORGANIZATION_PATH = "/organization/get-full-organization";

// Better Auth remains the owner of membership authorization and the read.
// Its untyped after-hook response is narrowed before applying the shared rule.
type FilteredInvitations =
  { type: "unchanged" } | { type: "filtered"; body: Record<string, unknown> };

const filterMemberInvitations = (
  returned: unknown,
  now: Date,
): FilteredInvitations => {
  if (!isRecord(returned) || !("invitations" in returned)) {
    return { type: "unchanged" };
  }
  const invitations = returned["invitations"];
  if (!isUnknownArray(invitations)) {
    return panic("Full organization response must contain invitations");
  }
  const body: Record<string, unknown> = {
    ...returned,
    invitations: invitations.filter((invitation) => {
      if (!isRecord(invitation)) {
        return panic("Full organization invitation must be an object");
      }
      const status = invitation["status"];
      const expiresAt = invitation["expiresAt"];
      if (
        !isInvitationStatus(status) ||
        !(expiresAt instanceof Date || typeof expiresAt === "string")
      ) {
        return panic("Full organization invitation has an invalid lifecycle");
      }
      return (
        classifyInvitation({ status, expiresAt }, now).section !== "hidden"
      );
    }),
  };
  return { type: "filtered", body };
};

export const createMemberInvitationSectionsPlugin = (
  middleware: typeof createAuthMiddleware,
  now: () => Date,
) =>
  ({
    id: "stella-member-invitation-sections",
    hooks: {
      after: [
        {
          matcher: ({ path }) => path === FULL_ORGANIZATION_PATH,
          handler: middleware(async (ctx) => {
            const filtered = filterMemberInvitations(
              ctx.context.returned,
              now(),
            );
            switch (filtered.type) {
              case "unchanged":
                return undefined;
              case "filtered":
                return await ctx.json(filtered.body);
              default: {
                filtered satisfies never;
                return panic("Unhandled invitation filter result");
              }
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
