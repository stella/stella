import { describe, expect, test } from "bun:test";

import fixtures from "@stll/api-contract/chat-local-run-step-output.fixtures";

import { runOutputKey, stepOutputGrant } from "./step-output-grants";

describe("a grant to read a run's step outputs", () => {
  test("is the key the computer derives for the same run, member, organization and expiry", () => {
    const { grant } = fixtures;
    expect(
      stepOutputGrant({
        outputKey: grant.outputKey,
        runId: grant.runId,
        owner: { userId: grant.userId, organizationId: grant.organizationId },
        now: grant.expiresAt - fixtures.grantSeconds,
      }),
    ).toEqual({ key: grant.grantHmac, expiresAt: grant.expiresAt });
  });

  test("differs for another member, organization or run", () => {
    const outputKey = runOutputKey("s".repeat(32), fixtures.grant.runId);
    const base = {
      outputKey,
      runId: fixtures.grant.runId,
      owner: { userId: "user-a", organizationId: "org-a" },
      now: 1_900_000_000,
    };
    const keys = [
      stepOutputGrant(base),
      stepOutputGrant({ ...base, owner: { ...base.owner, userId: "user-b" } }),
      stepOutputGrant({
        ...base,
        owner: { ...base.owner, organizationId: "org-b" },
      }),
      stepOutputGrant({
        ...base,
        outputKey: runOutputKey("s".repeat(32), Bun.randomUUIDv7()),
      }),
    ].map(({ key }) => key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(outputKey).toMatch(/^[0-9a-f]{64}$/u);
  });
});
