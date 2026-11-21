import { expect, test } from "bun:test";

import { DESKTOP_ACCOUNT_POLICY } from "@stll/api-contract/desktop-registry";

import {
  registryConnectionFailure,
  registryOperationFailure,
} from "../src/registry/registry-errors";

const { errorCodes } = DESKTOP_ACCOUNT_POLICY;

test("a role denial names its cause instead of the generic failure", () => {
  expect(registryOperationFailure(errorCodes.roleForbidden)).toBe("role");
  expect(registryConnectionFailure(errorCodes.roleForbidden)).toBe("role");
  expect(registryOperationFailure("Registry request failed")).toBe("failed");
});

test("a Keychain removal failure is shown, and anything else reads as a lookup failure", () => {
  expect(registryConnectionFailure(errorCodes.keychainClearFailed)).toBe(
    "keychain",
  );
  expect(registryConnectionFailure("Registry request failed")).toBe("lookup");
  expect(registryConnectionFailure(undefined)).toBe("lookup");
});
