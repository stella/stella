import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";

import { user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { createScopedDb } from "@/api/db/scoped";
import { resolveMentionTargets } from "@/api/lib/notifications";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;
let ids: TestIds;
let emailA1 = "";
let emailA2 = "";
let emailB1 = "";

const mentionsIn = async (text: string) =>
  await createScopedDb(
    testDb,
    [ids.wsA2],
    ids.orgA,
    ids.userA1,
  )(
    async (tx) =>
      // The embedded database's transaction handle is structurally the same
      // API with a different driver brand; the helper is driver-agnostic.
      await resolveMentionTargets(asTestRaw<Transaction>(tx), {
        actorUserId: ids.userA1,
        text,
        // Server-derived: userA1 and userA2 are both members of wsA2, userB1
        // is not a member of any workspace in organization A.
        workspaceId: ids.wsA2,
      }),
  );

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  const rows = await testDb
    .select({ id: user.id, email: user.email })
    .from(user);
  const emailOf = (id: string) =>
    rows.find((row) => row.id === id)?.email ??
    expect.unreachable(`missing fixture user ${id}`);
  emailA1 = emailOf(ids.userA1);
  emailA2 = emailOf(ids.userA2);
  emailB1 = emailOf(ids.userB1);
});

afterAll(async () => {
  await releaseRlsFixture();
});

describe("mention detection", () => {
  test("notifies a same-workspace member named by address", async () => {
    const { userIds, actorName } = await mentionsIn(
      `Please look at this @${emailA2}`,
    );

    expect(userIds).toEqual([ids.userA2]);
    expect(actorName).toBe("User A1");
  });

  test("ignores an address that is not a member of this workspace", async () => {
    // userB1 is a real account, just in another organization entirely. The
    // workspace membership join is the whole containment: without it, a
    // comment would be a way to probe for accounts.
    const { userIds } = await mentionsIn(`cc @${emailB1}`);

    expect(userIds).toEqual([]);
  });

  test("ignores an address that belongs to nobody", async () => {
    const { userIds } = await mentionsIn("ping @nobody@example.invalid");

    expect(userIds).toEqual([]);
  });

  test("never notifies the author of their own mention", async () => {
    const { userIds } = await mentionsIn(`note to self @${emailA1}`);

    expect(userIds).toEqual([]);
  });

  test("a bare address without the marker is not a mention", async () => {
    const { userIds } = await mentionsIn(`write to ${emailA2} directly`);

    expect(userIds).toEqual([]);
  });

  test("the same address twice notifies once", async () => {
    const { userIds } = await mentionsIn(`@${emailA2} and again @${emailA2}`);

    expect(userIds).toEqual([ids.userA2]);
  });
});
