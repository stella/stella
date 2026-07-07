import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { user, verification } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
import type { Transaction } from "@/api/db/root";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

/**
 * Discriminates which flow a confirmation OTP belongs to. Scopes the
 * verification-table identifier (`${purpose}:${email}`) so codes issued for
 * different flows never collide, even for the same email.
 */
export type ConfirmationOtpPurpose = "delete-account" | "two-factor-manage";

const CONFIRMATION_OTP_EXPIRY_MS = 5 * 60 * 1000;

const confirmationOtpIdentifier = (
  purpose: ConfirmationOtpPurpose,
  email: string,
): string => `${purpose}:${email}`;

/** Query surface both `rootDb` and a `rootDb.transaction` callback expose. */
type ConfirmationOtpDb = typeof rootDb | Transaction;

/**
 * Generates a cryptographically secure 6-digit numeric code (as a string).
 */
export const generateSixDigitOtp = (): string => {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const [val] = array;
  if (val === undefined) {
    panic("Failed to generate random value");
  }
  return (100_000 + (val % 900_000)).toString();
};

type CreateConfirmationOtpParams = {
  purpose: ConfirmationOtpPurpose;
  email: string;
};

/**
 * Generates and stores a confirmation OTP for the given purpose. Locks the
 * user row by email first so concurrent requests for the same email
 * serialize instead of racing on the verification table, then replaces any
 * existing code for this purpose/email with a fresh one that expires in 5
 * minutes. Returns the generated code so callers can email or (in dev) log
 * it.
 */
export const createConfirmationOtp = async ({
  purpose,
  email,
}: CreateConfirmationOtpParams): Promise<Result<string, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const identifier = confirmationOtpIdentifier(purpose, email);
      const otp = generateSixDigitOtp();

      await rootDb.transaction(async (tx) => {
        // Lock the user row by email first to serialize OTP requests for this email
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, email))
          .for("update");

        // Now we delete any existing OTP records for this identifier safely
        await tx
          .delete(verification)
          .where(eq(verification.identifier, identifier));

        const id = Bun.randomUUIDv7();
        await tx.insert(verification).values({
          id,
          identifier,
          value: otp,
          expiresAt: new Date(Date.now() + CONFIRMATION_OTP_EXPIRY_MS),
        });
      });

      return otp;
    },
    catch: (err) =>
      new HandlerError({
        status: 500,
        message: "Database operation failed",
        cause: err,
      }),
  });

type VerifyConfirmationOtpParams = {
  purpose: ConfirmationOtpPurpose;
  email: string;
  code: string;
  /**
   * Database handle to run the lookup/delete against. Defaults to `rootDb`;
   * pass an in-flight transaction so the check participates in a caller's
   * existing lock/atomicity guarantees (e.g. account deletion, which checks
   * the code inside the same transaction that holds the user row lock).
   */
  db?: ConfirmationOtpDb;
};

/**
 * Verifies a confirmation OTP for the given purpose. The verification row is
 * deleted on the first wrong attempt (preventing brute force) and on
 * success (making the code single-use); an expired code is also deleted.
 */
export const verifyConfirmationOtp = async ({
  purpose,
  email,
  code,
  db = rootDb,
}: VerifyConfirmationOtpParams): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const identifier = confirmationOtpIdentifier(purpose, email);

      const verificationRow = await db
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
        await db
          .delete(verification)
          .where(eq(verification.identifier, identifier));

        throw new HandlerError({
          status: 400,
          message: "Invalid verification code",
        });
      }

      if (verificationRow.expiresAt.getTime() < Date.now()) {
        await db
          .delete(verification)
          .where(eq(verification.identifier, identifier));

        throw new HandlerError({
          status: 400,
          message: "Verification code has expired",
        });
      }

      await db
        .delete(verification)
        .where(eq(verification.id, verificationRow.id));
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
