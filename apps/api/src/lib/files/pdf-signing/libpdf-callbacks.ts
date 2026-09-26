/**
 * The one place a signing `Result` becomes a rejection.
 *
 * LibPDF calls back into a `Signer` and a `TimestampAuthority` while it
 * signs, and learns of a failure only by the callback rejecting: there is no
 * other channel back through `pdf.sign`. The error rejected with is the
 * tagged error itself, so the caller that wrapped `pdf.sign` reads the same
 * value back out.
 */

import { Result } from "better-result";

export const settleForLibpdf = async <T, E>(
  pending: Promise<Result<T, E>>,
): Promise<T> => {
  const settled = await pending;
  if (Result.isError(settled)) {
    throw settled.error;
  }
  return settled.value;
};
