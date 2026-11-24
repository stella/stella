import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import type { DictationLearnedFixChange } from "@stll/api-contract/dictation-learned-fixes";
import { createTestClock } from "@stll/test-kit";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { dictationLearnedFixes } from "@/api/db/schema";
import {
  changeLearnedFixes,
  clearLearnedFixes,
  readLearnedFixes,
  toLearnedFixesAccountExport,
} from "@/api/lib/dictation/learned-fixes";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createScopedQuery,
  getTestDb,
  releaseTestDb,
} from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const clock = createTestClock();
let db: TestDatabase;
const organizationId = mintAuthProviderId<"organization">();
const otherOrganizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const colleagueId = mintAuthProviderId<"user">();

/** The member's own scope, as a signed-in request runs under row security. */
const as = (member: typeof userId, org = organizationId) => ({
  run: async <T>(fn: (tx: Transaction) => Promise<T>) =>
    await createScopedQuery(db)(
      [],
      org,
      // The scoped test transaction runs the statements a request's does.
      async (tx) => await fn(asTestRaw<Transaction>(tx)),
      member,
    ),
  owner: { organizationId: org, userId: member },
});

const corrected = (
  seq: number,
  from: string,
  to: string,
): DictationLearnedFixChange => ({ seq, type: "corrected", from, to });

/** Each device's id, kept with its change numbers. */
const DEVICE = {
  laptop: "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a01",
  phone: "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a02",
} as const;

beforeAll(async () => {
  db = await getTestDb();
  await db.insert(organization).values(
    [organizationId, otherOrganizationId].map((id) => ({
      id,
      name: "Learned fixes fixture",
      slug: id,
      createdAt: new Date(clock.now()),
    })),
  );
  await db.insert(user).values(
    [userId, colleagueId].map((id) => ({
      id,
      name: "Fixture member",
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );
});

afterAll(async () => {
  await releaseTestDb();
});

describe("learned dictation fixes", () => {
  test("a member with nothing learned reads generation 0 and no fixes", async () => {
    const member = as(userId);
    expect(
      await member.run(async (tx) => await readLearnedFixes(tx, member.owner)),
    ).toEqual({ generation: 0, fixes: [] });
  });

  test("changes apply once, in order", async () => {
    const member = as(userId);
    const apply = async (
      changes: DictationLearnedFixChange[],
      device: string = DEVICE.laptop,
    ) =>
      await member.run(
        async (tx) =>
          await changeLearnedFixes(tx, member.owner, {
            generation: 0,
            device,
            changes,
          }),
      );
    await apply([corrected(1, "Hrubeš", "Hrubesch")]);
    // A retried change is not a second sighting.
    expect(await apply([corrected(1, "Hrubeš", "Hrubesch")])).toEqual({
      generation: 0,
      fixes: [{ from: "Hrubeš", to: "Hrubesch", seen: 1, status: "learning" }],
    });
    // Another device counts its own changes.
    expect(
      await apply([corrected(1, "Hrubeš", "Hrubesch")], DEVICE.phone),
    ).toEqual({
      generation: 0,
      fixes: [{ from: "Hrubeš", to: "Hrubesch", seen: 2, status: "on" }],
    });
    // The laptop's first change, retried after the phone's, still counts once.
    await apply([corrected(1, "Hrubeš", "Hrubesch")]);
    const [row] = await db.select().from(dictationLearnedFixes);
    // Inserted at revision 0; only the phone's change wrote again.
    expect(row?.revision).toBe(1);
  });

  test("another member, or the same member in another organization, sees none of it", async () => {
    const colleague = as(colleagueId);
    expect(
      await colleague.run(
        async (tx) => await readLearnedFixes(tx, colleague.owner),
      ),
    ).toEqual({ generation: 0, fixes: [] });
    const elsewhere = as(userId, otherOrganizationId);
    expect(
      await elsewhere.run(
        async (tx) => await readLearnedFixes(tx, elsewhere.owner),
      ),
    ).toEqual({ generation: 0, fixes: [] });
    // Row security hides the member's row from a colleague's scope even
    // when the query names it.
    expect(
      await colleague.run(
        async (tx) =>
          await tx
            .select({ userId: dictationLearnedFixes.userId })
            .from(dictationLearnedFixes)
            .where(eq(dictationLearnedFixes.userId, userId)),
      ),
    ).toEqual([]);
  });

  test("deleting everything clears every device, and changes made before it are dropped", async () => {
    const member = as(userId);
    expect(
      await member.run(
        async (tx) =>
          await clearLearnedFixes(tx, member.owner, { generation: 0 }),
      ),
    ).toEqual({ generation: 1, fixes: [] });
    const late = await member.run(
      async (tx) =>
        await changeLearnedFixes(tx, member.owner, {
          generation: 0,
          device: DEVICE.laptop,
          changes: [corrected(2, "Lorenc", "Lorentz")],
        }),
    );
    expect(late).toEqual({ generation: 1, fixes: [] });
    // The phone learns after the deletion; its numbers go on from before it.
    const current = await member.run(
      async (tx) =>
        await changeLearnedFixes(tx, member.owner, {
          generation: 1,
          device: DEVICE.phone,
          changes: [{ seq: 2, type: "taught", from: "Lorenc", to: "Lorentz" }],
        }),
    );
    expect(current).toEqual({
      generation: 1,
      fixes: [{ from: "Lorenc", to: "Lorentz", seen: 1, status: "on" }],
    });
    // The laptop's deletion, retried after its answer was lost, leaves what
    // the phone learned since.
    expect(
      await member.run(
        async (tx) =>
          await clearLearnedFixes(tx, member.owner, { generation: 0 }),
      ),
    ).toEqual(current);
  });

  test("a change repeated within one request is applied once", async () => {
    const member = as(colleagueId, otherOrganizationId);
    const fixes = await member.run(
      async (tx) =>
        await changeLearnedFixes(tx, member.owner, {
          generation: 0,
          device: DEVICE.laptop,
          changes: [
            corrected(1, "Hrubeš", "Hrubesch"),
            corrected(1, "Hrubeš", "Hrubesch"),
          ],
        }),
    );
    expect(fixes).toEqual({
      generation: 0,
      fixes: [{ from: "Hrubeš", to: "Hrubesch", seen: 1, status: "learning" }],
    });
  });

  test("the account export reads the fixes back", async () => {
    const member = as(colleagueId);
    await member.run(
      async (tx) =>
        await changeLearnedFixes(tx, member.owner, {
          generation: 0,
          device: DEVICE.laptop,
          changes: [{ seq: 1, type: "taught", from: "Novacek", to: "Nováček" }],
        }),
    );
    const [row] = await db
      .select()
      .from(dictationLearnedFixes)
      .where(
        and(
          eq(dictationLearnedFixes.organizationId, organizationId),
          eq(dictationLearnedFixes.userId, colleagueId),
        ),
      );
    if (row === undefined) {
      panic("The fixture row is missing");
    }
    expect(await toLearnedFixesAccountExport(organizationId, row)).toEqual({
      generation: 0,
      fixes: [{ from: "Novacek", to: "Nováček", seen: 1, status: "on" }],
      updatedAt: row.updatedAt.toISOString(),
    });
  });
});
