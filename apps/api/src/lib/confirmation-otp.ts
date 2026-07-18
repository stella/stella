import { randomInt } from "node:crypto";

import { Result } from "better-result";
import { eq } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { user, verification } from "@/api/db/auth-schema";
import { rootDb } from "@/api/db/root";
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

/**
 * Generates a cryptographically secure 6-digit numeric code (as a string).
 * `randomInt` draws uniformly over `[100_000, 1_000_000)` (rejection sampling
 * under the hood), so unlike `Uint32 % 900_000` it has no modulo bias.
 */
export const generateSixDigitOtp = (): string =>
  randomInt(100_000, 1_000_000).toString();

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

/**
 * Purpose-specific error codes. Threaded in by callers whose frontend maps
 * codes to localized messages (e.g. account deletion) so this generic helper
 * surfaces that catalog's codes without depending on any one flow's error
 * module.
 */
type ConfirmationOtpErrorCodes = {
  invalid: string;
  expired: string;
};

type VerifyConfirmationOtpParams = {
  purpose: ConfirmationOtpPurpose;
  email: string;
  code: string;
  errorCode?: ConfirmationOtpErrorCodes;
};

type ConfirmationOtpRow = typeof verification.$inferSelect;

/**
 * Minimal root-database surface the atomic consume needs: a single
 * `DELETE ... RETURNING` on the verification table. Written structurally (not
 * `Pick<typeof rootDb, "delete">`, whose driver-specific result types reject a
 * PGlite test instance, and without importing a test-only type) so both the
 * bun-sql `rootDb` pool and a test database satisfy it. Deliberately not the
 * full `rootDb` type and, crucially, not a caller `Transaction` — see the
 * class note on `verifyConfirmationOtp` for why the burn must never run on a
 * caller's transaction.
 */
type ConfirmationOtpConsumeDb = {
  delete: (table: typeof verification) => {
    where: (condition: SQL) => {
      returning: () => PromiseLike<ConfirmationOtpRow[]>;
    };
  };
};

/**
 * Test-only seam for {@link verifyConfirmationOtp}. Runs the atomic
 * consume-and-verify against the supplied *root* database handle so a test can
 * inject its PGlite instance. Production code must call
 * `verifyConfirmationOtp`, which binds this to the module-level `rootDb` pool;
 * do not call this with a caller transaction (see the class note below).
 */
export const consumeConfirmationOtp = async (
  db: ConfirmationOtpConsumeDb,
  { purpose, email, code, errorCode }: VerifyConfirmationOtpParams,
): Promise<Result<void, HandlerError>> =>
  await Result.tryPromise({
    try: async () => {
      const identifier = confirmationOtpIdentifier(purpose, email);

      const [consumed] = await db
        .delete(verification)
        .where(eq(verification.identifier, identifier))
        .returning();

      if (!consumed || consumed.value !== code) {
        throw new HandlerError({
          ...(errorCode ? { code: errorCode.invalid } : {}),
          status: 400,
          message: "Invalid verification code",
        });
      }

      if (consumed.expiresAt.getTime() < Date.now()) {
        throw new HandlerError({
          ...(errorCode ? { code: errorCode.expired } : {}),
          status: 400,
          message: "Verification code has expired",
        });
      }
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

/**
 * Verifies and consumes a confirmation OTP for the given purpose. A single
 * `DELETE ... RETURNING` claims the row atomically, so two concurrent requests
 * can never both succeed on the same code (closing the check-then-delete
 * replay window). The row is removed whether the code is correct, wrong
 * (burn-on-first-attempt), or expired; the returned result only decides which
 * error, if any, to surface.
 *
 * Class: a state change that must survive an enclosing rollback. The burn has
 * to commit even when the caller's own business transaction aborts — otherwise
 * a wrong/expired guess that makes the caller roll back (e.g. account deletion
 * hitting a sole-owner check, or any failed verification) would restore the
 * row and reopen the code to replay/guessing. This function therefore takes no
 * caller database or transaction: the consume always runs on the module-level
 * `rootDb` pool, on its own connection, committing independently. Callers must
 * run their destructive work in a *separate* transaction, only after a
 * successful verify, so an abort there can never un-burn a consumed code.
 */
export const verifyConfirmationOtp = async (
  params: VerifyConfirmationOtpParams,
): Promise<Result<void, HandlerError>> =>
  await consumeConfirmationOtp(rootDb, params);
