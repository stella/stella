import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createSafeId } from "@/api/lib/branded-types";
import {
  authorizeDesktopLinkGrant,
  consumeDesktopLinkGrant,
  createDesktopLinkGrant,
} from "@/api/lib/business-registries/desktop/link-grants";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
const now = new Date("2026-01-01T12:00:00.000Z");
const verifier = "a".repeat(64);
const userId = createSafeId<"user">();
const organizationId = createSafeId<"organization">();

beforeAll(async () => {
  db = await getTestDb();
}, 120_000);
afterAll(async () => {
  await releaseTestDb();
});

const issue = async () => {
  const correlationId = Bun.randomUUIDv7();
  const result = await createDesktopLinkGrant({
    correlationId,
    userId,
    organizationId,
    verifierHash: createHash("sha256").update(verifier).digest("hex"),
    db,
    now,
  });
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.expiresAt).toBe("2026-01-01T12:01:00.000Z");
  }
  return {
    correlationId,
    verifier,
    expectedUserId: userId,
    expectedOrganizationId: organizationId,
    db,
    now,
  };
};

const expectRejected = (
  result: Awaited<ReturnType<typeof consumeDesktopLinkGrant>>,
) => {
  expect(result.isErr()).toBe(true);
  if (result.isErr()) {
    expect(result.error.status).toBe(401);
  }
};

test("a matching account link can be claimed once", async () => {
  const input = await issue();
  const first = await consumeDesktopLinkGrant(input);
  expect(first.isOk()).toBe(true);
  if (first.isOk()) {
    expect(first.value).toEqual({ userId, organizationId });
  }
  expectRejected(await consumeDesktopLinkGrant(input));
});

test("account links require matching request values", async () => {
  for (const changed of [
    { verifier: "b".repeat(64) },
    { expectedUserId: "01900000-0000-7000-8000-000000000003" },
    { expectedOrganizationId: "01900000-0000-7000-8000-000000000004" },
    { correlationId: "01900000-0000-7000-8000-000000000005" },
  ]) {
    const input = await issue();
    expectRejected(await consumeDesktopLinkGrant({ ...input, ...changed }));
    expect((await consumeDesktopLinkGrant(input)).isOk()).toBe(true);
  }
});

test("account links expire at the configured deadline", async () => {
  const input = await issue();
  expectRejected(
    await consumeDesktopLinkGrant({
      ...input,
      now: new Date(now.getTime() + 60_000),
    }),
  );
  expectRejected(
    await consumeDesktopLinkGrant({
      ...input,
      now: new Date(now.getTime() + 60_001),
    }),
  );
});

test("simultaneous account link claims have one result", async () => {
  const input = await issue();
  const results = await Promise.all([
    consumeDesktopLinkGrant(input),
    consumeDesktopLinkGrant(input),
  ]);
  expect(results.filter((result) => result.isOk())).toHaveLength(1);
  expect(results.filter((result) => result.isErr())).toHaveLength(1);
});

test("issuing an account link does not replace an existing link", async () => {
  const input = await issue();
  const replacement = await createDesktopLinkGrant({
    correlationId: input.correlationId,
    verifierHash: createHash("sha256").update("b".repeat(64)).digest("hex"),
    userId,
    organizationId,
    db,
    now,
  });
  expect(replacement.isErr()).toBe(true);
  expect((await consumeDesktopLinkGrant(input)).isOk()).toBe(true);
});

test("account link requests require complete credentials", async () => {
  for (const input of [
    undefined,
    null,
    {},
    { correlationId: Bun.randomUUIDv7() },
  ]) {
    expectRejected(await authorizeDesktopLinkGrant(input));
  }
});
