import { expect, test } from "bun:test";

import { LEGAL_HOLD_ACTIVE } from "@stll/api-contract/legal-holds";

import { isMcpErrorCode, projectMcpRefusal } from "@/api/mcp/error-codes";

test("legal hold refusals preserve their code and require an authorized human decision", () => {
  const refusal = projectMcpRefusal({
    status: 409,
    code: LEGAL_HOLD_ACTIVE,
    message: "An active legal hold prevents deletion.",
    retryable: true,
  });
  expect(isMcpErrorCode(LEGAL_HOLD_ACTIVE)).toBe(true);
  expect(refusal.code).toBe(LEGAL_HOLD_ACTIVE);
  expect(refusal.retryable).toBe(false);
  expect(refusal.issues).toEqual([]);
  expect(refusal.hint).toContain("authorized owner or administrator");
  expect(refusal.hint).toContain("explicit human approval");
  expect(refusal.hint).toContain("matters.legal-holds.release");
  expect(refusal.hint).toContain("entities.legal-holds.release");
  expect(refusal.hint).toContain("Do not release a hold automatically");
});
