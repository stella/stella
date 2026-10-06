/**
 * Usage (inside the API task, which carries the deployment env):
 *   bun /app/review-account.js provision
 *   bun /app/review-account.js set-password      # password on standard input
 *
 * `provision` creates, idempotently, the restricted review account named by
 * APP_REVIEW_ACCOUNT_EMAIL, the organization APP_REVIEW_ORGANIZATION_ID, and
 * the account's single owner membership. `set-password` reads one line from
 * standard input (never an argument or the environment), stores it through
 * Better Auth's password hashing, and ends the account's browser sessions;
 * OAuth grants stay. Only fixed outcome words and counts are printed.
 */
import { generateId } from "@better-auth/core/utils/id";
import { eq } from "drizzle-orm";

import { member, organization } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { env } from "@/api/env";
import { seedDefaultSkills } from "@/api/lib/agent-skills/default-skills";
import { getAuth } from "@/api/lib/auth";
import { ensureDefaultDocumentTypes } from "@/api/lib/document-types/defaults";
import {
  brandPersistedOrganizationId,
  brandPersistedUserId,
} from "@/api/lib/safe-id-boundaries";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import {
  createReviewAccountAuthStore,
  runReviewAccountCommand,
} from "@/api/scripts/review-account.logic";
import type { ReviewAccountStore } from "@/api/scripts/review-account.logic";

// Better Auth's default id length, the shape every auth row holds.
const AUTH_ID_LENGTH = 32;
const ORGANIZATION_NAME = "Sample law firm";

const insertOwner = async (
  tx: Parameters<Parameters<typeof rootDb.transaction>[0]>[0],
  { organizationId, userId }: { organizationId: string; userId: string },
) => {
  // A direct insert skips the organization plugin's membership hooks, so the
  // member defaults a real new owner gets are installed here.
  await tx.insert(member).values({
    id: generateId(AUTH_ID_LENGTH),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  await seedDefaultSkills({
    organizationId: brandPersistedOrganizationId(organizationId),
    tx,
    userId: brandPersistedUserId(userId),
  });
};

const createStore = async (): Promise<ReviewAccountStore> => {
  const context = await getAuth().$context;
  return {
    ...createReviewAccountAuthStore(context),
    organizationExists: async (organizationId) =>
      (await rootDb.query.organization.findFirst({
        where: { id: { eq: organizationId } },
        columns: { id: true },
      })) !== undefined,
    listOrganizationIdsForUser: async (userId) =>
      (
        await rootDb
          .select({ organizationId: member.organizationId })
          .from(member)
          .where(eq(member.userId, userId))
      ).map((row) => row.organizationId),
    listMemberUserIds: async (organizationId) =>
      (
        await rootDb
          .select({ userId: member.userId })
          .from(member)
          .where(eq(member.organizationId, organizationId))
      ).map((row) => row.userId),
    createOrganization: async ({ organizationId, ownerUserId }) => {
      // A direct insert skips the organization plugin's creation hook, so the
      // state and starter taxonomy a real new organization gets are written
      // here, with the owner, in one transaction.
      await rootDb.transaction(async (tx) => {
        const now = new Date();
        await tx.insert(organization).values({
          id: organizationId,
          name: ORGANIZATION_NAME,
          slug: `review-${organizationId.toLowerCase()}`,
          createdAt: now,
        });
        await recordNewOrganizationAccessState(tx, {
          organizationId: brandPersistedOrganizationId(organizationId),
          now,
        });
        await ensureDefaultDocumentTypes(
          brandPersistedOrganizationId(organizationId),
          tx,
        );
        await insertOwner(tx, { organizationId, userId: ownerUserId });
      });
    },
    addOwner: async (options) => {
      await rootDb.transaction(async (tx) => {
        await insertOwner(tx, options);
      });
    },
  };
};

const readStdin = (): AsyncIterable<Uint8Array> => {
  // On a terminal, raw mode keeps the typed password from being echoed.
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stderr.write("Password: ");
  }
  return process.stdin;
};

const exitCode = await runReviewAccountCommand({
  argv: process.argv.slice(2),
  config: {
    email: env.APP_REVIEW_ACCOUNT_EMAIL,
    organizationId: env.APP_REVIEW_ORGANIZATION_ID,
  },
  demoEmail: env.DEMO_ACCOUNT_EMAIL,
  io: {
    stdin: readStdin,
    writeOut: (line) => {
      process.stdout.write(`${line}\n`);
    },
    writeErr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  },
  store: createStore,
});
if (process.stdin.isTTY) {
  process.stdin.setRawMode(false);
  process.stderr.write("\n");
}
process.exit(exitCode);
