import { describe, expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

const testState = createTestState({ file: import.meta.path, config: {} });

testState.setEnvIfAbsent("VITE_API_URL", "http://localhost:3001");

const { documentReferenceKeys } =
  await import("@/lib/files/document-reference-queries");

describe("document reference query cache", () => {
  test("isolates the same verification code by active organization", () => {
    const verificationCode = "kx8mq2n4p3";
    const organizationA = documentReferenceKeys.byCode({
      organizationId: "org_1",
      verificationCode,
    });
    const organizationB = documentReferenceKeys.byCode({
      organizationId: "org_2",
      verificationCode,
    });

    expect(organizationA).toEqual([
      "document-reference",
      "org_1",
      verificationCode,
    ]);
    expect(organizationB).not.toEqual(organizationA);
  });
});
