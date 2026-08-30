import { describe, expect, test } from "bun:test";

import {
  parseOutlookFinalizeResponse,
  parseOutlookPresignResponse,
  parseOutlookReconcileResponse,
  parseOutlookWorkspacesResponse,
} from "./outlook-api";

describe("Outlook API wire contract", () => {
  test("accepts the narrow workspace projection and strips unrelated fields", () => {
    const parsed = parseOutlookWorkspacesResponse({
      workspaces: [
        {
          client: { displayName: "Client", internalField: "ignored" },
          id: "01994b00-0000-7000-8000-000000000001",
          internalField: "ignored",
          lastActivityAt: "2026-08-30T00:00:00.000Z",
          name: "Matter",
          reference: null,
        },
      ],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.output).toEqual({
        workspaces: [
          {
            client: { displayName: "Client" },
            id: "01994b00-0000-7000-8000-000000000001",
            lastActivityAt: "2026-08-30T00:00:00.000Z",
            name: "Matter",
            reference: null,
          },
        ],
      });
    }
  });

  test("accepts both email reservation states", () => {
    expect(
      parseOutlookPresignResponse({
        state: "existing",
        uploadId: "01994b00-0000-7000-8000-000000000002",
      }).success,
    ).toBe(true);
    expect(
      parseOutlookPresignResponse({
        expiresAt: "2026-08-30T01:00:00.000Z",
        headers: { "content-type": "message/rfc822" },
        state: "reserved",
        uploadId: "01994b00-0000-7000-8000-000000000003",
        url: "https://objects.example.test/upload",
      }).success,
    ).toBe(true);
  });

  test("fails closed for non-email finalize and unknown reconciliation states", () => {
    expect(
      parseOutlookFinalizeResponse({
        finalizedResult: { type: "entity_create" },
      }).success,
    ).toBe(false);
    expect(parseOutlookReconcileResponse({ state: "unknown" }).success).toBe(
      false,
    );
  });
});
