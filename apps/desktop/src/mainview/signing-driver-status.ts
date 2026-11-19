/**
 * The PKCS #11 module chosen for a smart card no known driver covers, as
 * the native side reports it (`pkcs11_module_setting::SigningDriverStatus`).
 */

export const SIGNING_DRIVER_CHANGED_EVENT = "signing-driver-changed";

const SIGNING_DRIVER_PROBLEMS = [
  "missing",
  "needs_update",
  "not_a_library",
] as const;
type SigningDriverProblem = (typeof SIGNING_DRIVER_PROBLEMS)[number];

export type SigningDriverNotice = SigningDriverProblem | "action_failed";

export type SigningDriverStatus = {
  path: string | null;
  problem: SigningDriverProblem | null;
};

const isProblem = (value: unknown): value is SigningDriverProblem =>
  SIGNING_DRIVER_PROBLEMS.some((problem) => problem === value);

export const isSigningDriverStatus = (
  value: unknown,
): value is SigningDriverStatus =>
  typeof value === "object" &&
  value !== null &&
  "path" in value &&
  (value.path === null || typeof value.path === "string") &&
  "problem" in value &&
  (value.problem === null || isProblem(value.problem));
