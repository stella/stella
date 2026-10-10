import type { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { sha256Hex as hashSha256Hex } from "@stll/sha256/node";

import { verification } from "@/api/db/auth-schema";
import {
  createDesktopLinkGrant,
  consumeDesktopLinkGrant,
} from "@/api/lib/business-registries/desktop/link-grant-store";
import {
  authorizeDesktopLinkGrant,
  parseDesktopLinkCredentials,
} from "@/api/lib/business-registries/desktop/link-grants";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
const now = new Date("2026-01-01T12:00:00.000Z");
const verifier = "a".repeat(64);
const deviceJkt = "A".repeat(43);
const userId = mintAuthProviderId<"user">();
const organizationId = mintAuthProviderId<"organization">();

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
    deviceJkt,
    userId,
    organizationId,
    verifierHash: hashSha256Hex(verifier),
    db,
    now,
  });
  expect(result.isErr() ? result.error : undefined).toBeUndefined();
  if (result.isOk()) {
    expect(result.value.expiresAt).toBe("2026-01-01T12:01:00.000Z");
  }
  return {
    correlationId,
    deviceJkt,
    verifier,
    expectedUserId: userId,
    expectedOrganizationId: organizationId,
    db,
    now,
  };
};

const expectRejected = (result: Result<unknown, HandlerError<401 | 503>>) => {
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
    expect(first.value).toEqual({ userId, organizationId, deviceJkt });
  }
  expectRejected(await consumeDesktopLinkGrant(input));
});

test("account links require matching request values", async () => {
  for (const changed of [
    { verifier: "b".repeat(64) },
    { deviceJkt: "B".repeat(43) },
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
    deviceJkt,
    verifierHash: hashSha256Hex("b".repeat(64)),
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
    expectRejected(
      await authorizeDesktopLinkGrant(
        input,
        new Request("http://localhost/redeem-link", { method: "POST" }),
      ),
    );
  }
});

test("account completion accepts provider identity values", () => {
  const parsed = parseDesktopLinkCredentials({
    correlationId: Bun.randomUUIDv7(),
    verifier,
    deviceJkt,
    expectedUserId: userId,
    expectedOrganizationId: organizationId,
  });
  expect(userId).toHaveLength(32);
  expect(organizationId).toHaveLength(32);
  expect(parsed.success).toBe(true);
  for (const expectedUserId of ["", " ", "a".repeat(129)]) {
    expect(
      parseDesktopLinkCredentials({
        correlationId: Bun.randomUUIDv7(),
        verifier,
        deviceJkt,
        expectedUserId,
        expectedOrganizationId: organizationId,
      }).success,
    ).toBe(false);
  }
});

test("account completion requires a base64url SHA-256 device thumbprint", () => {
  const input = {
    correlationId: Bun.randomUUIDv7(),
    verifier,
    deviceJkt,
    expectedUserId: userId,
    expectedOrganizationId: organizationId,
  };
  expect(parseDesktopLinkCredentials(input).success).toBe(true);
  const { deviceJkt: _deviceJkt, ...missingDevice } = input;
  expect(parseDesktopLinkCredentials(missingDevice).success).toBe(false);
  for (const proposedDeviceJkt of [
    "",
    "A".repeat(42),
    "A".repeat(44),
    `${"A".repeat(42)}=`,
    `${"A".repeat(42)}+`,
    `${"A".repeat(42)}/`,
  ]) {
    expect(
      parseDesktopLinkCredentials({ ...input, deviceJkt: proposedDeviceJkt })
        .success,
    ).toBe(false);
  }
});

test("issuing account links removes expired connection rows only", async () => {
  const rowId = `desktop-link:${Bun.randomUUIDv7()}`;
  const retainedId = Bun.randomUUIDv7();
  await db.insert(verification).values([
    { id: rowId, identifier: rowId, value: "pending", expiresAt: now },
    {
      id: retainedId,
      identifier: "email-confirmation",
      value: "pending",
      expiresAt: now,
    },
  ]);
  await issue();
  expect(
    await db.select().from(verification).where(eq(verification.id, rowId)),
  ).toHaveLength(0);
  expect(
    await db.select().from(verification).where(eq(verification.id, retainedId)),
  ).toHaveLength(1);
  await db.delete(verification).where(eq(verification.id, retainedId));
});
