import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

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
  id: string,
  from: string,
  to: string,
): DictationLearnedFixChange => ({ id, type: "corrected", from, to });

const ID = {
  first: "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a01",
  second: "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a02",
  third: "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a03",
  fourth: "0b8f8f3e-2b1c-4f7a-9a6e-1c2d3e4f5a04",
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
    const apply = async (changes: DictationLearnedFixChange[]) =>
      await member.run(
        async (tx) =>
          await changeLearnedFixes(tx, member.owner, {
            generation: 0,
            changes,
          }),
      );
    await apply([corrected(ID.first, "Hrubeš", "Hrubesch")]);
    // A retried change is not a second sighting.
    expect(await apply([corrected(ID.first, "Hrubeš", "Hrubesch")])).toEqual({
      generation: 0,
      fixes: [{ from: "Hrubeš", to: "Hrubesch", seen: 1, status: "learning" }],
    });
    expect(await apply([corrected(ID.second, "Hrubeš", "Hrubesch")])).toEqual({
      generation: 0,
      fixes: [{ from: "Hrubeš", to: "Hrubesch", seen: 2, status: "on" }],
    });
    const [row] = await db.select().from(dictationLearnedFixes);
    // Inserted at revision 0; the retried change wrote nothing.
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
      await member.run(async (tx) => await clearLearnedFixes(tx, member.owner)),
    ).toEqual({ generation: 1, fixes: [] });
    const late = await member.run(
      async (tx) =>
        await changeLearnedFixes(tx, member.owner, {
          generation: 0,
          changes: [corrected(ID.third, "Lorenc", "Lorentz")],
        }),
    );
    expect(late).toEqual({ generation: 1, fixes: [] });
    const current = await member.run(
      async (tx) =>
        await changeLearnedFixes(tx, member.owner, {
          generation: 1,
          changes: [
            { id: ID.fourth, type: "taught", from: "Lorenc", to: "Lorentz" },
          ],
        }),
    );
    expect(current).toEqual({
      generation: 1,
      fixes: [{ from: "Lorenc", to: "Lorentz", seen: 1, status: "on" }],
    });
  });

  test("the account export reads the fixes back", async () => {
    const [row] = await db.select().from(dictationLearnedFixes);
    if (row === undefined) {
      return panic("The fixture row is missing");
    }
    expect(await toLearnedFixesAccountExport(organizationId, row)).toEqual({
      generation: 1,
      fixes: [{ from: "Lorenc", to: "Lorentz", seen: 1, status: "on" }],
      updatedAt: row.updatedAt.toISOString(),
    });
  });
});
