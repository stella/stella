import { rootDb } from "@/api/db/root";
import { createConfirmedAccountUnlinker } from "@/api/lib/auth/unlink-account";
import { verifyConfirmationOtp } from "@/api/lib/confirmation-otp";

/** Bind the owner connection only when the auth request reaches this operation. */
export const unlinkAccountWithConfirmation = async (
  options: Parameters<ReturnType<typeof createConfirmedAccountUnlinker>>[0],
) =>
  await createConfirmedAccountUnlinker({
    database: rootDb,
    verifyConfirmation: verifyConfirmationOtp,
  })(options);
