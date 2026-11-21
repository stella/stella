import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";

const { errorCodes } = DESKTOP_ACCOUNT_POLICY;

/** Native registry commands reject with these codes when the UI must name the cause. */
export const registryOperationFailure = (error: unknown) =>
  error === errorCodes.roleForbidden ? "role" : "failed";

export const registryConnectionFailure = (error: unknown) => {
  if (error === errorCodes.roleForbidden) {
    return "role";
  }
  if (error === errorCodes.keychainClearFailed) {
    return "keychain";
  }
  return "lookup";
};
