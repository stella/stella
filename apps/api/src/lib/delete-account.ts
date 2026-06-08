import { Result } from "better-result";
import { and, eq, ne } from "drizzle-orm";

import { account, member, organization, session, user, verification } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Fetches the user email by ID.
 */
export const getUserEmail = async (
  currentUserId: string,
): Promise<Result<string, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const rows = await rootDb
        .select({ email: user.email })
        .from(user)
        .where(eq(user.id, currentUserId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new HandlerError({
          status: 404,
          message: "User not found",
        });
      }
      return row.email;
    },
    catch: (err) =>
      err instanceof HandlerError
        ? err
        : new HandlerError({
            status: 500,
            message: "Database query failed",
            cause: err,
          }),
  });

/**
 * Checks if the user is the sole owner of any organization they belong to.
 */
export const checkUserOrganizationOwnership = async (
  currentUserId: string,
): Promise<Result<{ isSoleOwner: boolean; orgName?: string }, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const ownedOrgs = await rootDb
        .select({
          orgId: member.organizationId,
          orgName: organization.name,
        })
        .from(member)
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(and(eq(member.userId, currentUserId), eq(member.role, "owner")));

      for (const org of ownedOrgs) {
        const otherOwners = await rootDb
          .select({ id: member.id })
          .from(member)
          .where(
            and(
              eq(member.organizationId, org.orgId),
              eq(member.role, "owner"),
              ne(member.userId, currentUserId),
            ),
          )
          .limit(1);

        if (otherOwners.length === 0) {
          return { isSoleOwner: true, orgName: org.orgName };
        }
      }

      return { isSoleOwner: false };
    },
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database query failed",
        cause: err,
      }),
  });

/**
 * Generates and stores a delete account OTP.
 */
export const createDeleteAccountOtp = async (
  email: string,
  otp: string,
): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const identifier = `delete-account:${email}`;

      // audit: skip — ephemeral verification code clean up
      await rootDb
        .delete(verification)
        .where(eq(verification.identifier, identifier));

      const id = Bun.randomUUIDv7();
      // audit: skip — ephemeral verification code insertion
      await rootDb.insert(verification).values({
        id,
        identifier,
        value: otp,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
      });
    },
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database operation failed",
        cause: err,
      }),
  });

/**
 * Verifies the OTP and deletes the user from the database.
 */
export const verifyAndDeleteUser = async (
  currentUserId: string,
  email: string,
  code: string,
): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const identifier = `delete-account:${email}`;

      await rootDb.transaction(async (tx) => {
        const verificationRow = await tx
          .select()
          .from(verification)
          .where(eq(verification.identifier, identifier))
          .limit(1)
          .then((rows) => rows[0]);

        if (!verificationRow) {
          throw new HandlerError({
            status: 400,
            message: "Invalid verification code",
          });
        }

        if (verificationRow.value !== code) {
          // Prevent brute force by deleting the OTP on the first incorrect attempt
          await tx
            .delete(verification)
            .where(eq(verification.identifier, identifier));

          throw new HandlerError({
            status: 400,
            message: "Invalid verification code",
          });
        }

        if (verificationRow.expiresAt.getTime() < Date.now()) {
          await tx
            .delete(verification)
            .where(eq(verification.identifier, identifier));

          throw new HandlerError({
            status: 400,
            message: "Verification code has expired",
          });
        }

        // 2. Perform ownership check with SELECT FOR UPDATE locks inside transaction
        // Fetch all organizations where the user is an owner, locking the member rows to prevent concurrent modifications
        const ownedOrgs = await tx
          .select({ orgId: member.organizationId, orgName: organization.name })
          .from(member)
          .innerJoin(organization, eq(organization.id, member.organizationId))
          .where(and(eq(member.userId, currentUserId), eq(member.role, "owner")))
          .for("update");

        for (const org of ownedOrgs) {
          const otherOwners = await tx
            .select({ id: member.id })
            .from(member)
            .where(
              and(
                eq(member.organizationId, org.orgId),
                eq(member.role, "owner"),
                ne(member.userId, currentUserId),
              ),
            )
            .limit(1)
            .for("update");

          if (otherOwners.length === 0) {
            throw new HandlerError({
              status: 400,
              message: `Cannot delete account because you are the sole owner of organization "${org.orgName}". Please transfer ownership or delete the organization first.`,
            });
          }
        }

        // audit: skip — ephemeral verification code deletion
        await tx
          .delete(verification)
          .where(eq(verification.id, verificationRow.id));

        // To maintain referential integrity with tables having "onDelete: restrict" (e.g. templates and usage ledger)
        // we anonymize the user profile, strip all active credentials, and clear sessions/memberships.
        // 1. Delete credentials and active sessions
        await tx.delete(account).where(eq(account.userId, currentUserId));
        await tx.delete(session).where(eq(session.userId, currentUserId));
        await tx.delete(member).where(eq(member.userId, currentUserId));

        // 2. Clear personal data in the user table and release the original email address
        await tx
          .update(user)
          .set({
            name: "Deleted User",
            email: `deleted-${currentUserId}@stella.placeholder`,
            emailVerified: false,
            image: null,
            preferredName: null,
            wordEditShortcut: null,
          })
          .where(eq(user.id, currentUserId));
      });
    },
    catch: (err) =>
      err instanceof HandlerError
        ? err
        : new HandlerError({
            status: 500,
            message: "Database operation failed",
            cause: err,
          }),
  });
