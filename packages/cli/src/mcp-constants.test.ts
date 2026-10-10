import { expect, test } from "bun:test";

import { EXIT_CODES, resolveMcpErrorCodeExit } from "./mcp-constants.js";

test("admission refusals distinguish retryable failures from operator action", () => {
  expect(resolveMcpErrorCodeExit("action_period_exhausted")).toBe(
    EXIT_CODES.usageLimited,
  );
  expect(resolveMcpErrorCodeExit("action_not_enabled")).toBe(
    EXIT_CODES.featureDisabled,
  );
  expect(resolveMcpErrorCodeExit("action_concurrency_busy")).toBe(
    EXIT_CODES.server,
  );
  expect(resolveMcpErrorCodeExit("action_admission_unavailable")).toBe(
    EXIT_CODES.server,
  );
});

test.each([
  "properties_limit_reached",
  "playbook_scope_unresolved",
  "file_property_type_immutable",
])(
  "%s is an issue code; its validation envelope remains correctable",
  (code) => {
    expect(resolveMcpErrorCodeExit(code)).toBeUndefined();
    expect(resolveMcpErrorCodeExit("validation_error")).toBe(
      EXIT_CODES.validation,
    );
  },
);
