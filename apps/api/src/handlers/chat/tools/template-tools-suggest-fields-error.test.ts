/**
 * Pins the `suggest_template_fields` tool's failure path: a
 * `suggestTemplateFields` rejection (BYOK misconfiguration, provider outage,
 * timeout) must still be captured for telemetry, but the tool must surface a
 * sanitized, stable message to the model instead of the raw provider error —
 * which can carry internals (key names, quota details) that must not reach
 * the model verbatim. Split into its own file — `mock.module` must run
 * before the module under test is first imported anywhere in this file's
 * module graph, and `template-tools.test.ts` already imports it statically.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { toSafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

const PROVIDER_ERROR = new Error(
  "upstream provider rejected request: invalid api key sk-live-abc123",
);

const suggestTemplateFieldsMock = mock(async () => {
  throw PROVIDER_ERROR;
});
const captureErrorMock = mock();

void mock.module("@/api/handlers/templates/suggest-template-fields", () => ({
  suggestTemplateFields: suggestTemplateFieldsMock,
}));

void mock.module("@/api/lib/analytics/capture", () => ({
  captureError: captureErrorMock,
  captureRequestError: captureErrorMock,
}));

// Bun runs every test file in one process, and `mock.module` mutates a
// shared registry: without restoring here, these `mock.module` calls (for
// `suggest-template-fields` and `analytics/capture`) would leak into
// whichever other test file runs next in the same process.
afterAll(() => {
  mock.restore();
});

const { createTemplateAuthoringTools, SUGGEST_TEMPLATE_FIELDS_TOOL_NAME } =
  await import("@/api/handlers/chat/tools/template-tools");

const organizationId = toSafeId<"organization">("org-test");
const userId = toSafeId<"user">("user-test");
// SAFETY: test double — usage metering only touches `safeDb` on a real
// model step, which never runs here (`suggestTemplateFields` is mocked to
// reject before any metering call).
// eslint-disable-next-line typescript/no-unsafe-type-assertion
const stubSafeDb = (() => {
  throw new Error("safeDb stub must not be called");
}) as unknown as SafeDb;

type SuggestFieldsExecute = (
  input: { text: string; instructions: string | null },
  options: unknown,
) => Promise<unknown>;

describe("suggest_template_fields tool error handling", () => {
  test("sanitizes the provider error before it reaches the model, while still capturing the original", async () => {
    const tools = createTemplateAuthoringTools({
      organizationId,
      orgAIConfig: null,
      safeDb: stubSafeDb,
      userId,
    });

    // SAFETY: invoke the tool's execute directly with a stub call context.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const execute = tools[SUGGEST_TEMPLATE_FIELDS_TOOL_NAME]
      .execute as unknown as SuggestFieldsExecute;

    const rejection: unknown = await execute(
      { instructions: null, text: "Granted by Example Corp." },
      {},
    ).then(
      () => null,
      (error: unknown) => error,
    );

    if (!ChatToolError.is(rejection)) {
      throw new Error("Expected a ChatToolError");
    }
    expect(rejection.message).not.toContain("sk-live-abc123");
    expect(rejection.message).toBe(
      "Template field suggestion failed; the workspace's AI provider returned an error.",
    );

    // The original error is still captured for telemetry, not swallowed.
    expect(captureErrorMock).toHaveBeenCalledWith(
      PROVIDER_ERROR,
      expect.anything(),
    );
  });
});
