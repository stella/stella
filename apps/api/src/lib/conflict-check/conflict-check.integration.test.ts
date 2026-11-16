import { panic } from "better-result";
import type { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { ConflictParty } from "@stll/api-contract/conflict-checks";

import type { SafeDb } from "@/api/db/safe-db";
import {
  conflictChecks,
  contacts,
  workspaceContacts,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb } from "@/api/db/scoped";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  decideConflictCheck,
  readConflictCheck,
  runConflictCheck,
} from "@/api/lib/conflict-check/operation";
import { executedRows } from "@/api/lib/db/executed-rows";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  CONFLICT_CHECKS_PAGE,
  conflictCheckListScalingScenario,
  conflictCheckReadScalingScenario,
  seedConflictChecksScaling,
} from "@/api/tests/read-scaling/conflict-checks";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

// Every name and identifier below is synthetic.

let testDb: TestDatabase;
let ids: TestIds;

const acmeId = createSafeId<"contact">();
const novakId = createSafeId<"contact">();
const walledMatterId = createSafeId<"workspace">();
const novakLinkId = createSafeId<"workspaceContact">();
const WALLED_NAME = "Walled matter Alpha";
const WALLED_REFERENCE = "WALL-ALPHA-1";

const audits: unknown[] = [];
const collectAudit: AuditRecorder = async (_tx, event) => {
  audits.push(event);
  await Promise.resolve();
};

const safeDbFor = (userId: SafeId<"user">) =>
  asTestRaw<SafeDb>(
    createMembershipSafeDb(testDb, {
      organizationId: ids.orgA,
      serverValidatedWorkspaceIds: [],
      userId,
    }),
  );

const run = async (
  userId: SafeId<"user">,
  parties: ConflictParty[],
  contactCap?: number,
) =>
  await runConflictCheck({
    safeDb: safeDbFor(userId),
    organizationId: ids.orgA,
    userId,
    title: "Intake",
    parties,
    recordAuditEvent: collectAudit,
    ...(contactCap === undefined ? {} : { contactCap }),
  });

const toCheckId = (id: string) => toSafeId<"conflictCheck">(id);

/** The HTTP status a refused operation carries, or null when it succeeded. */
const statusOf = (result: {
  isErr: () => boolean;
  error?: unknown;
}): unknown =>
  result.isErr() && result.error instanceof HandlerError
    ? result.error.status
    : null;

/** The value of a result the test expects to succeed. */
const expectOk = <T>(result: Result<T, { message: string }>): T =>
  result.isOk()
    ? result.value
    : panic(`Expected success: ${result.error.message}`);

const ACME_ADVERSE: ConflictParty = {
  type: "organization",
  role: "adverse",
  name: "ACME HOLDING a.s.",
  aliases: [],
};

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  await testDb.insert(contacts).values([
    {
      id: acmeId,
      organizationId: ids.orgA,
      type: "organization",
      displayName: "Acme Holding, spol. s r.o.",
      organizationName: "Acme Holding, spol. s r.o.",
      registrationNumber: "123 456 78",
    },
    {
      id: novakId,
      organizationId: ids.orgA,
      type: "person",
      displayName: "Jan Novák",
      firstName: "Jan",
      lastName: "Novák",
      dateOfBirthYear: 1971,
      dateOfBirthMonth: 4,
      dateOfBirthDay: 12,
    },
  ]);
  // A client matter nobody but its lead's firm management may open: the
  // member running the checks below is not on it.
  await testDb.insert(workspaces).values({
    id: walledMatterId,
    organizationId: ids.orgA,
    clientId: acmeId,
    leadUserId: ids.userAdmin,
    name: WALLED_NAME,
    reference: WALLED_REFERENCE,
    status: "active",
  });
  // Novák is the opposing party in a matter user A2 works on.
  await testDb.insert(workspaceContacts).values({
    id: novakLinkId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA2,
    contactId: novakId,
    role: "opposing_party",
  });
});

const clearChecks = async () => {
  await testDb
    .delete(conflictChecks)
    .where(eq(conflictChecks.organizationId, ids.orgA));
  audits.length = 0;
};

afterEach(clearChecks);

afterAll(async () => {
  await clearChecks();
  await testDb
    .delete(workspaceContacts)
    .where(eq(workspaceContacts.id, novakLinkId));
  await testDb.delete(workspaces).where(eq(workspaces.id, walledMatterId));
  await testDb.delete(contacts).where(inArray(contacts.id, [acmeId, novakId]));
  await releaseRlsFixture();
});

const hitFor = (
  view: Awaited<ReturnType<typeof run>>,
  contactId: SafeId<"contact">,
) => {
  const check = expectOk(view);
  const hit = check.parties
    .flatMap((party) => party.hits)
    .find((each) => each.contactId === contactId);
  return { view: check, hit: hit ?? panic("Expected a hit") };
};

describe("conflict check against walled matters", () => {
  test("a match in a matter the runner cannot open shows only a count, a severity and whom to ask", async () => {
    const { view, hit } = hitFor(await run(ids.userA2, [ACME_ADVERSE]), acmeId);
    expect(view.outcome).toBe("potential_conflict");
    expect(hit.tier).toBe("exact_name");
    expect(hit.matters).toEqual([]);
    expect(hit.walled).toEqual([
      {
        severity: "potential_conflict",
        count: 1,
        contacts: [{ userId: ids.userAdmin, name: expect.any(String) }],
        askAdministrator: false,
      },
    ]);
    // Nothing identifies the walled matter or the contact's place in it.
    const serialized = JSON.stringify(view);
    for (const secret of [walledMatterId, WALLED_NAME, WALLED_REFERENCE]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of ['"relation"', '"role":"client"', '"state"']) {
      expect(serialized).not.toContain(field);
    }
  });

  test("a walled matter reads the same whatever side the party is submitted on", async () => {
    const walledFor = async (role: ConflictParty["role"]) =>
      hitFor(await run(ids.userA2, [{ ...ACME_ADVERSE, role }]), acmeId).hit
        .walled;
    const adverse = await walledFor("adverse");
    expect(await walledFor("client")).toEqual(adverse);
    expect(await walledFor("related")).toEqual(adverse);
  });

  test("the stored record keeps no role or state for a walled matter", async () => {
    const created = expectOk(await run(ids.userA2, [ACME_ADVERSE]));
    const [row] = await testDb
      .select({ results: conflictChecks.results })
      .from(conflictChecks)
      .where(eq(conflictChecks.id, toCheckId(created.id)));
    const links = row?.results.parties.flatMap((party) =>
      party.hits.flatMap((each) => each.links),
    );
    expect(links).toEqual([
      {
        access: "walled",
        workspaceId: walledMatterId,
        severity: "potential_conflict",
      },
    ]);
  });

  test("the database routine itself returns no role or state for a walled matter", async () => {
    const rows = await safeDbFor(ids.userA2)(
      async (tx) =>
        await tx.execute(sql`
          SELECT accessible, relation, role, matter_state, severity
          FROM public.stella_conflict_contact_links(
            ${ids.orgA}, 'adverse', ARRAY[${acmeId}]::uuid[]
          )
        `),
    );
    expect(rows.isOk() && executedRows(rows.value)).toEqual([
      {
        accessible: false,
        relation: null,
        role: null,
        matter_state: null,
        severity: "potential_conflict",
      },
    ]);
  });

  test("firm management, who may open client matters, sees the matter itself", async () => {
    const { hit } = hitFor(await run(ids.userAdmin, [ACME_ADVERSE]), acmeId);
    expect(hit.walled).toEqual([]);
    expect(hit.matters).toEqual([
      {
        workspaceId: walledMatterId,
        name: WALLED_NAME,
        reference: WALLED_REFERENCE,
        relation: "client",
        role: null,
        state: "open",
        severity: "potential_conflict",
      },
    ]);
  });

  test("an opposing party in the runner's own matter is a potential conflict for a new client", async () => {
    const { view, hit } = hitFor(
      await run(ids.userA2, [
        {
          type: "person",
          role: "client",
          firstName: "Novak",
          lastName: "Jan",
          dateOfBirth: { precision: "day", year: 1971, month: 4, day: 12 },
          aliases: [],
        },
      ]),
      novakId,
    );
    expect(view.outcome).toBe("potential_conflict");
    expect(hit.evidence.birthDate).toBe("match");
    expect(hit.matters).toEqual([
      expect.objectContaining({
        workspaceId: ids.wsA2,
        relation: "matter_role",
        role: "opposing_party",
        state: "open",
        severity: "potential_conflict",
      }),
    ]);
  });

  test("a check that could not read the whole address book is incomplete, never no matches", async () => {
    const view = expectOk(
      await run(
        ids.userA2,
        [
          {
            type: "organization",
            role: "client",
            name: "Zzyzx Unmatched Ltd",
            aliases: [],
          },
        ],
        1,
      ),
    );
    expect(view.outcome).toBe("incomplete");
    expect(view.coverage).toEqual({
      contactsScreened: 1,
      gaps: ["contacts_over_cap"],
    });
  });

  test("a session outside the organization cannot reach the routine", async () => {
    const outsider = asTestRaw<SafeDb>(
      createMembershipSafeDb(testDb, {
        organizationId: ids.orgA,
        serverValidatedWorkspaceIds: [],
        userId: ids.userB1,
      }),
    );
    const refused = await outsider(
      async (tx) =>
        await tx.execute(sql`
          SELECT * FROM public.stella_conflict_contact_links(
            ${ids.orgA}, 'client', ARRAY[${acmeId}]::uuid[]
          )
        `),
    );
    expect(refused.isErr()).toBe(true);
  });
});

describe("conflict check records and decisions", () => {
  test("only the runner and firm management read a check", async () => {
    const checkId = toCheckId(
      expectOk(await run(ids.userA2, [ACME_ADVERSE])).id,
    );
    const readAs = async (userId: SafeId<"user">) =>
      await readConflictCheck({
        safeDb: safeDbFor(userId),
        organizationId: ids.orgA,
        checkId,
      });
    expect((await readAs(ids.userA2)).isOk()).toBe(true);
    expect((await readAs(ids.userAdmin)).isOk()).toBe(true);
    const colleague = await readAs(ids.userA1);
    expect(statusOf(colleague)).toBe(404);
  });

  test("a waiver takes a reviewer, and a stale decision is refused", async () => {
    const checkId = toCheckId(
      expectOk(await run(ids.userA2, [ACME_ADVERSE])).id,
    );
    const decide = async (
      userId: SafeId<"user">,
      isReviewer: boolean,
      input: Parameters<typeof decideConflictCheck>[0]["input"],
    ) =>
      await decideConflictCheck({
        safeDb: safeDbFor(userId),
        organizationId: ids.orgA,
        checkId,
        userId,
        input,
        isReviewer,
        recordAuditEvent: collectAudit,
      });
    const waiver = {
      decision: "waived",
      expectedDecision: "pending",
      expectedRevision: 0,
      note: "Both clients consented in writing",
      consentReference: "Consent letters of 3 November",
    } as const;
    const byRunner = await decide(ids.userA2, false, waiver);
    expect(statusOf(byRunner)).toBe(403);
    const byReviewer = await decide(ids.userAdmin, true, waiver);
    expect(byReviewer.isOk() && byReviewer.value.decision).toBe("waived");
    const stale = await decide(ids.userAdmin, true, {
      decision: "conflict",
      expectedDecision: "pending",
      expectedRevision: 0,
      note: "Consent withdrawn",
    });
    expect(statusOf(stale)).toBe(409);
    expect(
      audits.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          "action" in event &&
          event.action === "review",
      ),
    ).toHaveLength(1);
  });
});

describe("conflict check read scaling", () => {
  test("lists and reads the same work for the member's checks whatever a colleague holds", async () => {
    const seedAt = async (size: number) =>
      await seedConflictChecksScaling(testDb, {
        organizationId: ids.orgA,
        otherUserId: ids.userA2,
        userId: ids.userA1,
        size,
      });
    const small = await seedAt(10);
    try {
      const list10 = await conflictCheckListScalingScenario.measure(small);
      const read10 = await conflictCheckReadScalingScenario.measure(small);
      await small.cleanup();
      const large = await seedAt(200);
      try {
        const list200 = await conflictCheckListScalingScenario.measure(large);
        const read200 = await conflictCheckReadScalingScenario.measure(large);
        expect(list10.rows).toBe(CONFLICT_CHECKS_PAGE);
        expect(list200.rows).toBe(CONFLICT_CHECKS_PAGE);
        expect(
          readScalingViolations({ small: list10, large: list200 }),
        ).toEqual([]);
        expect(
          readScalingViolations({ small: read10, large: read200 }),
        ).toEqual([]);
      } finally {
        await large.cleanup();
      }
    } finally {
      await small.cleanup();
    }
  });
});
