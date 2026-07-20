import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";

import { apikey, member, organization, user } from "@/api/db/auth-schema";
import { revokeOrganizationMemberAuthArtifacts } from "@/api/lib/auth-artifacts";
import { toSafeId } from "@/api/lib/branded-types";
import { MACHINE_API_KEY_CONFIG_ID } from "@/api/lib/machine-api-key-config";
import type { TestDatabase } from "@/api/tests/security/test-utils";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

/**
 * Machine API keys must not outlive the membership they were issued under.
 *
 * Removing a member used to break their keys only *incidentally*:
 * `mcp/api-key-auth.ts` resolves the owner's `member` row and rejects the
 * credential when there is none, so the key row itself survived untouched.
 * Re-invite the same person and the member row comes back, and every machine
 * key they ever minted in that organization starts working again. That makes
 * offboarding reversible by accident and makes "remove the member" a
 * non-answer when a key has leaked.
 *
 * These run against real SQL on PGlite rather than a mocked transaction
 * because the whole question is whether the `WHERE` clause scopes correctly:
 * the organization lives inside a JSON metadata column, `apikey` denies the
 * scoped `stella` role so there is no RLS underneath, and a predicate that is
 * subtly wrong in either direction (too narrow, keys survive; too broad, one
 * organization's removal kills another's credentials) is invisible to the
 * type system.
 */

const ORG_A = "org-removal-a";
const ORG_B = "org-removal-b";
const LEAVER = "user-removal-leaver";
const COLLEAGUE = "user-removal-colleague";

const KEY_IN_ORG_A = "key-leaver-org-a";
const KEY_IN_ORG_B = "key-leaver-org-b";
const KEY_OF_COLLEAGUE = "key-colleague-org-a";
const KEY_OTHER_CONFIG = "key-leaver-other-config";

const machineMetadata = (organizationId: string) =>
  JSON.stringify({ organizationId, scopes: ["stella:read"] });

type SeedKey = {
  configId: string;
  id: string;
  organizationId: string;
  ownerUserId: string;
};

const SEED_KEYS: readonly SeedKey[] = [
  {
    configId: MACHINE_API_KEY_CONFIG_ID,
    id: KEY_IN_ORG_A,
    organizationId: ORG_A,
    ownerUserId: LEAVER,
  },
  {
    configId: MACHINE_API_KEY_CONFIG_ID,
    id: KEY_IN_ORG_B,
    organizationId: ORG_B,
    ownerUserId: LEAVER,
  },
  {
    configId: MACHINE_API_KEY_CONFIG_ID,
    id: KEY_OF_COLLEAGUE,
    organizationId: ORG_A,
    ownerUserId: COLLEAGUE,
  },
  // Same owner, same organization, but minted under a different plugin
  // configuration. The machine-key scope must not reach it.
  {
    configId: "some-other-config",
    id: KEY_OTHER_CONFIG,
    organizationId: ORG_A,
    ownerUserId: LEAVER,
  },
];

let testDb: TestDatabase;

const readKey = async (id: string) =>
  await testDb
    .select({ enabled: apikey.enabled, id: apikey.id })
    .from(apikey)
    .where(eq(apikey.id, id))
    .then((rows) => rows.at(0) ?? null);

const seedKeys = async (): Promise<void> => {
  await testDb.delete(apikey).where(eq(apikey.referenceId, LEAVER));
  await testDb.delete(apikey).where(eq(apikey.referenceId, COLLEAGUE));

  await testDb.insert(apikey).values(
    SEED_KEYS.map(({ configId, id, organizationId, ownerUserId }) => ({
      configId,
      enabled: true,
      id,
      // `key` is uniquely indexed (it holds a digest), so each row needs its own.
      key: `digest-${id}`,
      metadata: machineMetadata(organizationId),
      name: id,
      permissions: JSON.stringify({ workspace: ["read"] }),
      referenceId: ownerUserId,
      start: "stella_mk_abc",
    })),
  );
};

const removeLeaverFromOrgA = async (): Promise<void> => {
  await testDb.transaction(
    async (tx) =>
      await revokeOrganizationMemberAuthArtifacts(tx, {
        organizationId: toSafeId<"organization">(ORG_A),
        userId: toSafeId<"user">(LEAVER),
      }),
  );
};

const addMembership = async (
  organizationId: string,
  userId: string,
): Promise<void> => {
  await testDb
    .insert(member)
    .values({
      createdAt: new Date(),
      id: `member-${organizationId}-${userId}`,
      organizationId,
      role: "member",
      userId,
    })
    .onConflictDoNothing();
};

beforeAll(async () => {
  testDb = await getTestDb();

  await testDb
    .insert(organization)
    .values([
      { createdAt: new Date(), id: ORG_A, name: "Org A", slug: ORG_A },
      { createdAt: new Date(), id: ORG_B, name: "Org B", slug: ORG_B },
    ])
    .onConflictDoNothing();

  await testDb
    .insert(user)
    .values([
      { email: `${LEAVER}@example.test`, id: LEAVER, name: "Leaver" },
      { email: `${COLLEAGUE}@example.test`, id: COLLEAGUE, name: "Colleague" },
    ])
    .onConflictDoNothing();

  await addMembership(ORG_A, LEAVER);
  await addMembership(ORG_B, LEAVER);
  await addMembership(ORG_A, COLLEAGUE);
});

afterAll(async () => {
  await releaseTestDb();
});

describe("machine keys on organization member removal", () => {
  test("removing a member revokes the machine keys they hold in that organization", async () => {
    await seedKeys();

    await removeLeaverFromOrgA();

    expect(await readKey(KEY_IN_ORG_A)).toEqual({
      enabled: false,
      id: KEY_IN_ORG_A,
    });
  });

  test("the key row survives revocation so its audit trail and `start` prefix do", async () => {
    // Disabled rather than deleted, matching `handlers/api-keys/revoke.ts`. A
    // deleted row takes with it the only thing that lets an operator match a
    // leaked credential back to the key it came from.
    await seedKeys();

    await removeLeaverFromOrgA();

    const row = await testDb
      .select({ start: apikey.start })
      .from(apikey)
      .where(eq(apikey.id, KEY_IN_ORG_A))
      .then((rows) => rows.at(0) ?? null);

    expect(row).not.toBeNull();
    expect(row?.start).toBe("stella_mk_abc");
  });

  test("keys the same user holds in another organization are untouched", async () => {
    // The scope is (owner AND organization). Dropping the organization half
    // would revoke credentials in an organization the user has not left.
    await seedKeys();

    await removeLeaverFromOrgA();

    expect(await readKey(KEY_IN_ORG_B)).toEqual({
      enabled: true,
      id: KEY_IN_ORG_B,
    });
  });

  test("keys another member holds in the same organization are untouched", async () => {
    // Dropping the owner half would revoke the whole organization's keys on
    // any single removal.
    await seedKeys();

    await removeLeaverFromOrgA();

    expect(await readKey(KEY_OF_COLLEAGUE)).toEqual({
      enabled: true,
      id: KEY_OF_COLLEAGUE,
    });
  });

  test("keys minted under a different plugin configuration are untouched", async () => {
    await seedKeys();

    await removeLeaverFromOrgA();

    expect(await readKey(KEY_OTHER_CONFIG)).toEqual({
      enabled: true,
      id: KEY_OTHER_CONFIG,
    });
  });

  test("re-inviting the member does not resurrect their old keys", async () => {
    // The actual vulnerability. Before revocation was part of member removal,
    // the key row survived untouched and only failed because the membership
    // lookup came up empty — so restoring the membership restored the key.
    // `resolveMachineApiKeySession` checks `enabled` *before* it resolves
    // membership, so a key disabled here stays dead no matter who is a member.
    await seedKeys();

    await removeLeaverFromOrgA();
    await testDb
      .delete(member)
      .where(and(eq(member.organizationId, ORG_A), eq(member.userId, LEAVER)));

    // Re-invited: the membership that made the key resolve is back.
    await addMembership(ORG_A, LEAVER);

    const membership = await testDb
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, ORG_A), eq(member.userId, LEAVER)))
      .then((rows) => rows.at(0) ?? null);
    expect(membership).not.toBeNull();

    expect(await readKey(KEY_IN_ORG_A)).toEqual({
      enabled: false,
      id: KEY_IN_ORG_A,
    });
  });

  test("revocation is idempotent and leaves an already-revoked row alone", async () => {
    await seedKeys();

    await removeLeaverFromOrgA();
    const afterFirst = await testDb
      .select({ updatedAt: apikey.updatedAt })
      .from(apikey)
      .where(eq(apikey.id, KEY_IN_ORG_A))
      .then((rows) => rows.at(0) ?? null);

    await removeLeaverFromOrgA();
    const afterSecond = await testDb
      .select({ updatedAt: apikey.updatedAt })
      .from(apikey)
      .where(eq(apikey.id, KEY_IN_ORG_A))
      .then((rows) => rows.at(0) ?? null);

    // `updated_at` keeps pointing at the revocation that actually happened.
    expect(afterSecond?.updatedAt).toEqual(afterFirst?.updatedAt);
  });
});
