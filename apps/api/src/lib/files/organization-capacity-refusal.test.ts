import { expect, test } from "bun:test";

import { ORGANIZATION_CAPACITY_CODES } from "@stll/api-contract/organization-capacity";

import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "./organization-file-usage";

test("storage capacity refusal keeps its domain code and client status", () => {
  const error = new OrganizationFileUsageError({
    reason: "capacity_exceeded",
    message: "Storage is full",
  });
  expect(error.status).toBe(413);
  const refusal = organizationFileUsageHandlerError(error);
  expect(refusal).toMatchObject({
    code: ORGANIZATION_CAPACITY_CODES.storageFull,
    status: 413,
    message: "Storage is full",
  });
});
